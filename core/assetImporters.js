import sharp from 'sharp';

const formats = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

// Importers own format validation and preview preparation. Storage, ownership,
// message references, and node scopes are independent of this first asset kind.
export const imageImporter = {
  kind: 'image',
  accepts(bytes) {
    const signature = bytes.subarray(0, 12);
    return signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || (signature[0] === 255 && signature[1] === 216 && signature[2] === 255)
      || ['GIF87a', 'GIF89a'].includes(signature.subarray(0, 6).toString('ascii'))
      || (signature.subarray(0, 4).toString('ascii') === 'RIFF' && signature.subarray(8, 12).toString('ascii') === 'WEBP');
  },
  async prepare(bytes, { pixels }) {
    const image = sharp(bytes, { limitInputPixels: pixels, failOn: 'warning', animated: true });
    const metadata = await image.metadata();
    if (!formats[metadata.format]) throw new Error('Use PNG, JPEG, WebP, or static GIF');
    if ((metadata.pages ?? 1) !== 1) throw new Error('Animated images are not supported');
    const display = await image.rotate().png().toBuffer({ resolveWithObject: true });
    const thumbnail = await sharp(display.data).resize(160, 120, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    return {
      metadata: { mimeType: formats[metadata.format], width: display.info.width, height: display.info.height },
      variants: {
        display: { bytes: display.data, mimeType: 'image/png', transformations: ['auto-orient', 'strip-metadata', 'png'] },
        thumbnail: { bytes: thumbnail, mimeType: 'image/png', transformations: ['resize:160x120'] },
      },
    };
  },
};

// Add a future importer here only alongside its provider transport/capability
// and preview support. Unsupported bytes never become image references.
export const ASSET_IMPORTERS = Object.freeze([imageImporter]);
