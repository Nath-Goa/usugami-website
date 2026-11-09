// Decodes HEIC photos off the page's thread (see heif-decode.js): libheif takes a second or two for
// a 12-megapixel photo, which would otherwise freeze the screen.
import { decodeHeifPixels } from './heif-decode.js';

self.onmessage = async (e) => {
  const { id, bytes } = e.data;
  try {
    const result = await decodeHeifPixels(bytes);
    self.postMessage({ id, result }, [result.data.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
