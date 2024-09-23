import * as fs from "fs";
import * as path from "path";
import {
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import chokidar from "chokidar";
import { config } from "./config";
import { s3Client } from "./s3Client";
import { calculateMD5, logError } from "./utils";

interface FileState {
  path: string;
  md5: string;
  lastModified: Date;
}

let localState: Map<string, FileState> = new Map();
let s3State: Map<string, FileState> = new Map();

async function uploadToS3(filePath: string) {
  const fileContent = fs.readFileSync(filePath);
  const key = path.relative(config.localFolderPath, filePath);

  const command = new PutObjectCommand({
    Bucket: config.bucketName,
    Key: key,
    Body: fileContent,
  });

  try {
    await s3Client.send(command);
    console.log(`Uploaded ${key} to S3`);

    const md5 = await calculateMD5(filePath);
    s3State.set(key, { path: key, md5, lastModified: new Date() });
  } catch (error) {
    logError(`Error uploading ${key}`, error);
  }
}

async function downloadFromS3(key: string) {
  const command = new GetObjectCommand({
    Bucket: config.bucketName,
    Key: key,
  });

  try {
    const response = await s3Client.send(command);
    const filePath = path.join(config.localFolderPath, key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, await response.Body!.transformToByteArray());
    console.log(`Downloaded ${key} from S3`);

    const md5 = await calculateMD5(filePath);
    localState.set(key, { path: key, md5, lastModified: new Date() });
  } catch (error) {
    logError(`Error downloading ${key}`, error);
  }
}

async function deleteFromS3(key: string) {
  const command = new DeleteObjectCommand({
    Bucket: config.bucketName,
    Key: key,
  });

  try {
    await s3Client.send(command);
    console.log(`Deleted ${key} from S3`);
    s3State.delete(key);
  } catch (error) {
    logError(`Error deleting ${key}`, error);
  }
}

async function deleteLocal(key: string) {
  const filePath = path.join(config.localFolderPath, key);
  try {
    fs.unlinkSync(filePath);
    console.log(`Deleted ${filePath} locally`);
    localState.delete(key);
  } catch (error) {
    logError(`Error deleting ${filePath}`, error);
  }
}

async function syncS3ToLocal() {
  const command = new ListObjectsV2Command({ Bucket: config.bucketName });

  try {
    const response = await s3Client.send(command);
    if (response.Contents) {
      for (const object of response.Contents) {
        const key = object.Key!;
        const s3LastModified = object.LastModified!;
        const localFile = localState.get(key);

        if (!localFile || localFile.lastModified < s3LastModified) {
          await downloadFromS3(key);
        }
      }
    }
  } catch (error) {
    logError("Error syncing S3 to local", error);
  }
}

async function syncLocalToS3() {
  for (const [key, localFile] of localState) {
    const s3File = s3State.get(key);
    if (!s3File || localFile.md5 !== s3File.md5) {
      await uploadToS3(path.join(config.localFolderPath, key));
    }
  }

  for (const [key] of s3State) {
    if (!localState.has(key)) {
      await deleteFromS3(key);
    }
  }
}

async function initializeS3State() {
  const command = new ListObjectsV2Command({ Bucket: config.bucketName });

  try {
    const response = await s3Client.send(command);
    if (response.Contents) {
      for (const object of response.Contents) {
        const key = object.Key!;
        s3State.set(key, {
          path: key,
          md5: object.ETag!.replace(/"/g, ""),
          lastModified: object.LastModified!,
        });
      }
    }
  } catch (error) {
    logError("Error initializing S3 state", error);
  }
}

async function initializeLocalState() {
  const files = fs.readdirSync(config.localFolderPath, {
    recursive: true,
  }) as string[];
  for (const file of files) {
    const filePath = path.join(config.localFolderPath, file);
    if (fs.statSync(filePath).isFile()) {
      const md5 = await calculateMD5(filePath);
      localState.set(file, {
        path: file,
        md5,
        lastModified: fs.statSync(filePath).mtime,
      });
    }
  }
}

async function performInitialSync() {
  console.log("Performing initial sync...");

  for (const [key, s3File] of s3State) {
    const localFile = localState.get(key);
    if (!localFile || localFile.md5 !== s3File.md5) {
      if (config.isDryRun) {
        console.log(`[DRY RUN] Would download ${key} from S3 to local`);
      } else {
        await downloadFromS3(key);
      }
    }
  }

  for (const [key, localFile] of localState) {
    const s3File = s3State.get(key);
    if (!s3File || localFile.md5 !== s3File.md5) {
      if (config.isDryRun) {
        console.log(`[DRY RUN] Would upload ${key} from local to S3`);
      } else {
        await uploadToS3(path.join(config.localFolderPath, key));
      }
    }
  }

  for (const [key] of s3State) {
    if (!localState.has(key)) {
      if (config.isDryRun) {
        console.log(`[DRY RUN] Would delete ${key} from S3`);
      } else {
        await deleteFromS3(key);
      }
    }
  }

  for (const [key] of localState) {
    if (!s3State.has(key)) {
      if (config.isDryRun) {
        console.log(`[DRY RUN] Would delete ${key} locally`);
      } else {
        await deleteLocal(key);
      }
    }
  }

  console.log("Initial sync completed.");
}

async function main() {
  await initializeS3State();
  await initializeLocalState();
  await performInitialSync();

  const watcher = chokidar.watch(config.localFolderPath, {
    persistent: true,
    ignoreInitial: true,
  });

  watcher
    .on("add", async (filePath) => {
      try {
        const key = path.relative(config.localFolderPath, filePath);
        const md5 = await calculateMD5(filePath);
        localState.set(key, { path: key, md5, lastModified: new Date() });
        await uploadToS3(filePath);
      } catch (error) {
        logError(`Error adding ${filePath}`, error);
      }
    })
    .on("change", async (filePath) => {
      try {
        const key = path.relative(config.localFolderPath, filePath);
        const md5 = await calculateMD5(filePath);
        localState.set(key, { path: key, md5, lastModified: new Date() });
        await uploadToS3(filePath);
      } catch (error) {
        logError(`Error changing ${filePath}`, error);
      }
    })
    .on("unlink", async (filePath) => {
      try {
        const key = path.relative(config.localFolderPath, filePath);
        localState.delete(key);
        await deleteFromS3(key);
      } catch (error) {
        logError(`Error deleting ${filePath}`, error);
      }
    });

  setInterval(async () => {
    await syncS3ToLocal();
    await syncLocalToS3();
  }, 60000);

  console.log(
    `${config.isDryRun ? "[DRY RUN] " : ""}Watching ${
      config.localFolderPath
    } for changes and syncing with S3...`
  );
}

main().catch(console.error);
