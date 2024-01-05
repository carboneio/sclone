# Changelog

All notable changes to this project will be documented in this file. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.1.0
- Released the 2024/01/05
- Fixed Synchro with S3 Scaleway: The etag from ListObjectV2 was returning encoded double quotes "&#34;" instead of "\"".
- Fixed "logSync" option: if enabled, the `logs` folder is created automatically if it does not exist.
- Updated dev npm packages

## 1.0.0 
- Released the 2023/09/07
- Added executable for MacOS and Linux
- Added documentation
- Added changelog
- Cleaned and open-sourced the code