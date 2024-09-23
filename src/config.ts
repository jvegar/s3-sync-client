import dotenv from "dotenv";

dotenv.config();

export const config = {
  awsRegion: process.env.AWS_REGION,
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_ACCESS_KEY_SECRET,
  bucketName: process.env.BUCKET_NAME,
  localFolderPath: process.env.LOCAL_FOLDER_PATH ?? "",
  isDryRun: process.env.DRY_RUN === "true",
};
