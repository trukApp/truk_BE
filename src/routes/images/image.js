const express = require('express');
const router = express.Router();
const { logger } = require('../../logger/logger');
const jwtAuth = require('../../JWT/jwtAuth');
const mime = require('mime-types');
const AWS = require('aws-sdk');
const fileUpload = require("express-fileupload");
require('dotenv').config();

router.use(express.json());
router.use(express.urlencoded({ extended: true }));
router.use(fileUpload());

AWS.config.update({
  accessKeyId: process.env.AWS_ID,
  secretAccessKey: process.env.SECRET_KEY,
});


const s3 = new AWS.S3();

const allowedMimeTypes = ['image/jpeg', 'image/png', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

router.post("/upload", jwtAuth.verifyToken, async (req, res) => {
  try {
    if (!req.files || !req.files.image) {
      return res.status(400).json({ message: "No file uploaded" });
    }
    const imageFile = req.files.image;
    const mimeType = mime.lookup(imageFile.name);

    if (!allowedMimeTypes.includes(mimeType)) {
      return res.status(400).json({ message: " Invalid file type" });
    }


    // const mimeType = mime.lookup(imageFile.name);

    const params = {
      Bucket: "trukapp",
      Key: imageFile.name,
      Body: imageFile.data,
      ACL: "public-read",
      ContentDisposition: 'inline',
      ContentType: mimeType || 'application/octet-stream'
    };

    const uploadResult = await s3.upload(params).promise();

    res.status(200).json({
      message:"File uploaded successfully",
      imageUrl: uploadResult.Location,
    });
  } catch (error) {
    logger.error("Error uploading image:", error);
    res.status(400).json({ message:"Error uploading image" });
  }
});


router.delete("/delete-image", jwtAuth.verifyToken, async (req, res) => {
  const { imageKey } = req.query;

  if (!imageKey) {
    return res.status(400).json({ message: 'imageKey is required to delete the image.' });
  }

  try {
    const key = imageKey.includes('amazonaws.com/') ? imageKey.split('.com/')[1] : imageKey;

    const params = {
      Bucket: "trukapp",
      Key: key,
    };

    await s3.deleteObject(params).promise();

    res.status(200).json({
      message: "File deleted successfully",
      deletedImageKey: key
    });
  } catch (error) {
    logger.error("Error deleting image:", error);
    res.status(500).json({ message: "Failed to delete the image", error: error.message });
  }
});



module.exports = router;