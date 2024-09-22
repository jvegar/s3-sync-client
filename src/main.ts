import * as fs from 'fs';
import * as path from 'path';
import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, GetObjectCommand, S3ClientConfig } from "@aws-sdk/client-s3";
import chokidar from 'chokidar';
import crypto from 'crypto';
import 'dotenv/config';

const s3Client = new S3Client(
	{ 
		region: process.env.AWS_REGION,
		credentials: {
			secretAccessKey: process.env.AWS_ACCESS_KEY_SECRET,
			accessKeyId: process.env.AWS_ACCESS_KEY_ID
		}
	} as S3ClientConfig);
const bucketName = process.env.BUCKET_NAME;
const localFolderPath = "/storage/emulated/0/Documents/jvegar-vault";
const isDryRun = process.env.DRY_RUN === 'true';

interface FileState {
    path: string;
    md5: string;
    lastModified: Date;
}

let localState: Map<string, FileState> = new Map();
let s3State: Map<string, FileState> = new Map();

// ... (previous functions like calculateMD5, uploadToS3, downloadFromS3, etc. remain the same)
async function calculateMD5(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

async function uploadToS3(filePath: string) {
    const fileContent = fs.readFileSync(filePath);
    const key = path.relative(localFolderPath, filePath);
    
    const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: fileContent,
    });

    try {
        await s3Client.send(command);
        console.log(`Uploaded ${key} to S3`);
        
        const md5 = await calculateMD5(filePath);
        s3State.set(key, { path: key, md5, lastModified: new Date() });
    } catch (error) {
        console.error(`Error uploading ${key}:`, error);
    }
}

async function downloadFromS3(key: string) {
    const command = new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
    });

    try {
        const response = await s3Client.send(command);
        const filePath = path.join(localFolderPath, key);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, await response.Body!.transformToByteArray());
        console.log(`Downloaded ${key} from S3`);

        const md5 = await calculateMD5(filePath);
        localState.set(key, { path: key, md5, lastModified: new Date() });
    } catch (error) {
        console.error(`Error downloading ${key}:`, error);
    }
}

async function deleteFromS3(key: string) {
    const command = new DeleteObjectCommand({
        Bucket: bucketName,
        Key: key,
    });

    try {
        await s3Client.send(command);
        console.log(`Deleted ${key} from S3`);
        s3State.delete(key);
    } catch (error) {
        console.error(`Error deleting ${key}:`, error);
    }
}

async function deleteLocal(key: string) {
    const filePath = path.join(localFolderPath, key);
    try {
        fs.unlinkSync(filePath);
        console.log(`Deleted ${filePath} locally`);
        localState.delete(key);
    } catch (error) {
        console.error(`Error deleting ${filePath}:`, error);
    }
}

async function syncS3ToLocal() {
    const command = new ListObjectsV2Command({ Bucket: bucketName });
    
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
        console.error("Error syncing S3 to local:", error);
    }
}

async function syncLocalToS3() {
    for (const [key, localFile] of localState) {
        const s3File = s3State.get(key);
        if (!s3File || localFile.md5 !== s3File.md5) {
            await uploadToS3(path.join(localFolderPath, key));
        }
    }

    // Delete files from S3 that don't exist locally
    for (const [key] of s3State) {
        if (!localState.has(key)) {
            await deleteFromS3(key);
        }
    }
}

async function initializeS3State() {
    const command = new ListObjectsV2Command({ Bucket: bucketName });
    
    try {
        const response = await s3Client.send(command);
        if (response.Contents) {
            for (const object of response.Contents) {
                const key = object.Key!;
                s3State.set(key, { 
                    path: key, 
                    md5: object.ETag!.replace(/"/g, ''), // ETag is usually the MD5 hash
                    lastModified: object.LastModified!
                });
            }
        }
    } catch (error) {
        console.error("Error initializing S3 state:", error);
    }
}

async function initializeLocalState() {
    const files = fs.readdirSync(localFolderPath, { recursive: true }) as string[];
    for (const file of files) {
        const filePath = path.join(localFolderPath, file);
        if (fs.statSync(filePath).isFile()) {
            const md5 = await calculateMD5(filePath);
            localState.set(file, { 
                path: file, 
                md5, 
                lastModified: fs.statSync(filePath).mtime 
            });
        }
    }
}

async function performInitialSync() {
    console.log("Performing initial sync...");

    // Sync S3 to Local
    for (const [key, s3File] of s3State) {
        const localFile = localState.get(key);
        if (!localFile || localFile.md5 !== s3File.md5) {
            if (isDryRun) {
                console.log(`[DRY RUN] Would download ${key} from S3 to local`);
            } else {
                await downloadFromS3(key);
            }
        }
    }

    // Sync Local to S3
    for (const [key, localFile] of localState) {
        const s3File = s3State.get(key);
        if (!s3File || localFile.md5 !== s3File.md5) {
            if (isDryRun) {
                console.log(`[DRY RUN] Would upload ${key} from local to S3`);
            } else {
                await uploadToS3(path.join(localFolderPath, key));
            }
        }
    }

    // Handle deletions
    for (const [key] of s3State) {
        if (!localState.has(key)) {
            if (isDryRun) {
                console.log(`[DRY RUN] Would delete ${key} from S3`);
            } else {
                await deleteFromS3(key);
            }
        }
    }

    for (const [key] of localState) {
        if (!s3State.has(key)) {
            if (isDryRun) {
                console.log(`[DRY RUN] Would delete ${key} locally`);
            } else {
                await deleteLocal(key);
            }
        }
    }

    console.log("Initial sync completed.");
}

// Main execution
async function main() {
    await initializeS3State();
    await initializeLocalState();
    await performInitialSync();

    // Set up watcher for continuous sync (as before)
const watcher = chokidar.watch(localFolderPath, {
    persistent: true,
    ignoreInitial: true
});

watcher
    .on('add', async (filePath) => {
        const key = path.relative(localFolderPath, filePath);
        const md5 = await calculateMD5(filePath);
        localState.set(key, { path: key, md5, lastModified: new Date() });
        await uploadToS3(filePath);
    })
    .on('change', async (filePath) => {
        const key = path.relative(localFolderPath, filePath);
        const md5 = await calculateMD5(filePath);
        localState.set(key, { path: key, md5, lastModified: new Date() });
        await uploadToS3(filePath);
    })
    .on('unlink', async (filePath) => {
        const key = path.relative(localFolderPath, filePath);
        localState.delete(key);
        await deleteFromS3(key);
    });

    // Periodic sync (as before)
    setInterval(async () => {
        await syncS3ToLocal();
        await syncLocalToS3();
    }, 60000); // Sync every minute

    console.log(`${isDryRun ? '[DRY RUN] ' : ''}Watching ${localFolderPath} for changes and syncing with S3...`);
}

main().catch(console.error);
