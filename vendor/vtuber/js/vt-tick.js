// vtuber.html's pulse: a worker's timer keeps ticking when the window is minimised or behind others (a page's own
// timers may be slowed down there). Each tick only wakes the page; the page itself answers the server.
setInterval(() => postMessage(0), 350);
