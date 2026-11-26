// V9 SHOW OPENING: EVERY WORD ON THE COUNTDOWN CARD, in one place. Edit the text between the quotes; nothing else
// needs to change. Keep lines short (a panel line fits about 32 letters). Nothing here should state a price, a payout
// or a promise, and the card must never ask for gifts (TikTok LIVE rules).
// THE OWNER CHECKS: the BOOST and SKIP lines are a plain reading of the words, not taken from the site.
(function (root, factory) {
  const copy = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = copy;
  root.VTShowCopy = copy;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  return {
  brand: 'REACTIVVIBE AI', starts: 'THE SHOW STARTS IN', live: 'WE ARE LIVE',
  queue: { title: 'IS YOUR SONG UP TONIGHT?', sub: 'Next in the queue' },
  boosts: { title: 'BOOSTS + SKIPS', lines: [['BOOST', 'moves a song up the queue'], ['SKIP', 'jumps a song to the front'], ['', 'Both are on the song page']] },
  engage: { title: 'EVERY TAP. EVERY GIFT.', lines: [['TAP', 'the screen: it charges the ignition'], ['GIFTS', 'charge it faster'], ['FULL', 'meter = a bigger opening']] },
  meter: 'IGNITION', taps: 'TAPS', gifts: 'GIFTS', go: "LET'S GET REACTIVE",
  // COUNTDOWN 2.0 (the Mask fills with light as the clock runs down): its own lines. It never asks for gifts.
  mask: { next: 'NEXT UP', tap: 'TAP THE SCREEN', tapLine: 'every tap sends energy into the Mask', taps: 'TAPS', boost: 'BOOST', skip: 'SKIP' },
};
});
