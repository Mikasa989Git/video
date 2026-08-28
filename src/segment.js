// One shot per full sentence/line — the fix for "cutting mid-sentence" discovered today.
// Never split a long sentence across two shots; never merge two sentences into one shot.

function wordCount(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

function segmentScript(scriptText) {
  const lines = scriptText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.map((text, i) => ({ scene: i + 1, text, words: wordCount(text) }));
}

module.exports = { segmentScript, wordCount };
