// Looks for the page off the page's thread (see crop.js findPageOnImage()), so the screen stays
// responsive while the crop screen opens.
import { findPage } from './outline.js';

self.onmessage = (e) => {
  const { id, rgba, width, height } = e.data;
  try {
    self.postMessage({ id, outline: findPage(rgba, width, height) });
  } catch (error) {
    self.postMessage({ id, error: String(error?.message ?? error) });
  }
};
