// V8 ENGINE: a chat poll. Pure UMD, no DOM, no clock of its own, seeded (js/v8/README.md, section 3).
//
//   const votes = VTVotes.create({ seed });
//   votes.start({ question: 'What colour?', options: ['Hot Pink', 'Gold', { label: 'Ice', words: ['blue'], action: { colour: '#59f2ff' } }], seconds: 30 }, t)
//   votes.cast('viewer-id', '2', t);   votes.cast({ id: 'x' }, 'gold', t);
//   const v = votes.step(t);           // options with counts and shares, seconds left, and the result when it is over
//
// One vote per viewer, the last one counts. A vote is the option's number or its word as the WHOLE comment, so normal
// chat ("that was 2 good") does not vote. The engine never reads or keeps any other comment text.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  root.VTVotes = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const RESULT_FOR = 6;          // s the result stays in the state

  // The votes the "random vote every few minutes" switch draws from. `action` is the page's business.
  const DEFAULT_VOTES = [
    { id: 'boss', question: 'Fight the Mask in a boss battle?', options: [{ label: 'Fight', words: ['yes', 'fight'], action: 'boss' }, { label: 'Mercy', words: ['no', 'mercy'], action: null }], seconds: 30, needsNoSong: true },
    { id: 'size', question: 'What do we do to him?', options: [{ label: 'Shrink', words: ['small', 'tiny'], action: 'shrink' }, { label: 'HUGE', words: ['big', 'giant'], action: 'huge' }, { label: 'Leave him', words: ['leave', 'nothing'], action: null }], seconds: 30 },
    { id: 'colour', question: 'What colour should he be?', options: [{ label: 'Hot Pink', words: ['pink'], action: { colour: '#ff2d95' } }, { label: 'Gold', action: { colour: '#ffb52e' } }, { label: 'Ice', words: ['blue'], action: { colour: '#59f2ff' } }, { label: 'Crimson', words: ['red'], action: { colour: null } }], seconds: 30 },
    { id: 'power', question: 'Which power next?', options: [{ label: 'Goo', action: { puppet: 'goo' } }, { label: 'Fire', action: { puppet: 'fire' } }, { label: 'Melt', action: { puppet: 'melt' } }, { label: 'Crack', action: { puppet: 'crack' } }], seconds: 25 },
  ];

  /** a comment as a vote key: lower case, no leading ! or #, keycap digits to digits, spaces squeezed; '' when it is not a short answer */
  function norm(text) {
    if (text == null) return '';
    let s = String(text).normalize('NFKC').replace(/[️⃣]/g, '').toLowerCase().trim();
    s = s.replace(/^[!#]+/, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
    return s.length > 40 ? '' : s;
  }

  function create({ seed = 20261120 } = {}) {
    let s0 = seed | 0;
    const rnd = () => { s0 = (s0 + 0x6D2B79F5) | 0; let t = Math.imul(s0 ^ (s0 >>> 15), 1 | s0); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    let poll = null, result = null, ev = [], now = null, recent = [];
    const push = (e) => { e.t = now; ev.push(e); };

    function start(def, t) {
      now = t;
      if (!def || (poll && !poll.done)) return false;
      const raw = Array.isArray(def.options) ? def.options : [];
      if (raw.length < 2 || raw.length > 4 || !def.question) return false;
      const options = raw.map((o, i) => {
        const label = String(typeof o === 'string' ? o : o.label);
        const keys = new Set([String(i + 1), norm(label)]);
        if (o && Array.isArray(o.words)) for (const w of o.words) keys.add(norm(w));
        keys.delete('');
        return { n: i + 1, label, keys, action: o && typeof o === 'object' && 'action' in o ? o.action : label, votes: 0 };
      });
      // a word that would mean two options means none
      const seen = new Map();
      for (const o of options) for (const k of o.keys) seen.set(k, (seen.get(k) || 0) + 1);
      for (const o of options) for (const k of [...o.keys]) if (seen.get(k) > 1) o.keys.delete(k);
      const seconds = clamp(Number(def.seconds) || 30, 5, 300);
      poll = { id: def.id != null ? def.id : null, question: String(def.question), options, at: t, seconds, by: new Map(), total: 0, lead: -1, last5: false, done: false };
      result = null;
      push({ type: 'vote-start', id: poll.id, question: poll.question, options: options.map((o) => o.label), seconds });
      return true;
    }

    function cast(viewer, text, t) {
      if (!poll || poll.done || t - poll.at >= poll.seconds) return -1;
      const id = viewer && typeof viewer === 'object' ? viewer.id : viewer;
      if (id == null) return -1;
      const key = norm(text);
      if (!key) return -1;
      const i = poll.options.findIndex((o) => o.keys.has(key));
      if (i < 0) return -1;
      now = t;
      const sid = String(id), had = poll.by.get(sid);
      if (had === i) return i;
      if (had != null) poll.options[had].votes--; else poll.total++;
      poll.by.set(sid, i); poll.options[i].votes++;
      push({ type: 'vote-cast', option: i, changed: had != null });
      return i;
    }

    function cancel(t) { now = t; if (poll && !poll.done) { poll = null; result = null; push({ type: 'vote-clear' }); return true; } return false; }

    function leader() {
      if (!poll || !poll.total) return -1;
      let best = -1, n = 0, tie = false;
      poll.options.forEach((o, i) => { if (o.votes > n) { n = o.votes; best = i; tie = false; } else if (o.votes === n && n > 0) tie = true; });
      return tie ? -1 : best;
    }

    function step(t) {
      now = t;
      if (poll && !poll.done) {
        const left = poll.seconds - (t - poll.at);
        const l = leader();
        if (l !== poll.lead) { poll.lead = l; if (l >= 0) push({ type: 'vote-lead', option: l }); }
        if (!poll.last5 && left <= 5 && left > 0) { poll.last5 = true; push({ type: 'vote-last5' }); }
        if (left <= 0) {
          poll.done = true;
          let winner = -1, tie = false;
          if (poll.total > 0) {
            const top = Math.max(...poll.options.map((o) => o.votes)), tops = poll.options.map((o, i) => (o.votes === top ? i : -1)).filter((i) => i >= 0);
            tie = tops.length > 1; winner = tie ? tops[Math.floor(rnd() * tops.length)] : tops[0];
          }
          const o = winner >= 0 ? poll.options[winner] : null;
          result = { winner, label: o ? o.label : null, action: o ? o.action : null, votes: o ? o.votes : 0, total: poll.total, tie, at: poll.at + poll.seconds };
          push({ type: 'vote-end', id: poll.id, winner, label: result.label, action: result.action, tie });
        }
      }
      if (poll && poll.done && result && t - result.at >= RESULT_FOR) { poll = null; result = null; push({ type: 'vote-clear' }); }
      const events = ev; ev = [];
      if (!poll) return { t, active: false, id: null, question: null, options: [], total: 0, left: 0, k: 0, result: null, events };
      const lead = poll.done ? (result ? result.winner : -1) : poll.lead;
      const left = clamp(poll.seconds - (t - poll.at), 0, poll.seconds);
      return {
        t, active: !poll.done, id: poll.id, question: poll.question,
        options: poll.options.map((o, i) => ({ n: o.n, label: o.label, votes: o.votes, share: poll.total ? o.votes / poll.total : 0, leading: i === lead })),
        total: poll.total, left, k: 1 - left / poll.seconds,
        result: result ? { winner: result.winner, label: result.label, action: result.action, votes: result.votes, total: result.total, tie: result.tie, age: t - result.at } : null,
        events,
      };
    }

    /** one vote from the list for the "random vote" switch: not one of the last two, no boss vote while a song plays or a fight is on */
    function pickRandom(list, { songPlaying = false, fight = false } = {}) {
      const all = (list && list.length ? list : DEFAULT_VOTES).filter((d) => !((songPlaying || fight) && (d.needsNoSong || d.id === 'boss')));
      if (!all.length) return null;
      const keyOf = (d) => (d.id != null ? d.id : d.question);
      let pool = all.filter((d) => !recent.includes(keyOf(d)));
      if (!pool.length) pool = all.filter((d) => keyOf(d) !== recent[recent.length - 1]);
      if (!pool.length) pool = all;
      const pick = pool[Math.floor(rnd() * pool.length)];
      recent.push(keyOf(pick)); if (recent.length > 2) recent.shift();
      return pick;
    }

    return { start, cast, cancel, step, pickRandom, get active() { return !!(poll && !poll.done); } };
  }

  /**
   * The "random vote every few minutes" switch as a clock: tell it each frame what is going on, it says when a vote is due.
   *   const sched = VTVotes.scheduler({ every: 240, first: 90 });
   *   if (sched.due(t, { on, busy })) votes.start(votes.pickRandom(null, { songPlaying }), t);
   * busy = a vote, a fight or anything else that should not be talked over; a due vote waits for it and then 10 s more.
   */
  function scheduler({ every = 240, first = null } = {}) {
    let next = null, wasOn = false;
    return {
      due(t, { on = true, busy = false } = {}) {
        if (!on) { wasOn = false; next = null; return false; }
        if (!wasOn) { wasOn = true; next = t + (first != null ? first : every); }
        if (busy) { if (next < t + 10) next = t + 10; return false; }
        if (t >= next) { next = t + every; return true; }
        return false;
      },
      get next() { return next; },
    };
  }

  return { create, scheduler, norm, DEFAULT_VOTES, RESULT_FOR };
});
