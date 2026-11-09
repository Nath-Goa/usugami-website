// How the Word, PowerPoint, Excel and EPUB converters pause during long work, so the page can draw
// and answer the user.

/**
 * Lets the browser paint and answer input, and the page's own timers run: the work goes on in a new
 * task at the back of the queue. Not with a timer: in a tab in the background, timers run once a
 * second at most, which would slow a long document to a crawl while the user looks elsewhere. (Nor
 * with scheduler.yield(), which goes ahead of the page's timers, such as the one that shows the
 * progress dialog, and holds them up.)
 * @returns {Promise<void>}
 */
export function pause() {
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}
