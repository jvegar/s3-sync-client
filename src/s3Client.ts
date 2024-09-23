import { S3Client, S3ClientConfig } from "@aws-sdk/client-s3";
import { config } from "./config";

const s3ClientConfig: S3ClientConfig = {
  region: config.awsRegion,
  credentials: {
    accessKeyId: config.awsAccessKeyId!,
    secretAccessKey: config.awsSecretAccessKey!,
  },
};

export const s3Client = new S3Client(s3ClientConfig);
