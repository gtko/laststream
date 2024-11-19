$tag = $(git describe --abbrev=0)
aws s3 cp --acl public-read ".\StremioSetup-v$((get-item .\StremioSetup*.exe).VersionInfo.ProductVersion.Trim()).exe" s3://stremio-artifacts/stremio-shell-ng/$tag/
node ./generate_descriptor.js --tag=$tag
