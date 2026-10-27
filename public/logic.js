// Regras do jogo que não dependem da tela: leitura da resposta e ranking.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QuizLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var RX = /^(?:(?:letra|alternativa|opcao|resposta|item|opc)\s*)?([abcd])\s*[).:!,;\-]*$/;

  // Devolve "A", "B", "C" ou "D" quando o comentário inteiro é uma resposta. Senão, null.
  function parseAnswer(text) {
    if (typeof text !== 'string') return null;
    var s = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
    // tira emojis, aspas e enfeites; "A 😀", "*b*" e "a!!" viram "a" e "b"
    s = s.replace(/[^a-z0-9\s)(.:!,;\-]/g, ' ').replace(/[\s]+/g, ' ').trim();
    if (!s || s.length > 24) return null;
    var m = RX.exec(s);
    return m ? m[1].toUpperCase() : null;
  }

  // Mais acertos primeiro. Em empate, quem somou menos tempo de resposta (mais rápido).
  function rank(players) {
    return Object.keys(players || {})
      .map(function (k) {
        var p = players[k];
        return { k: k, name: p.name, hits: p.hits || 0, time: p.time || 0 };
      })
      .filter(function (p) { return p.hits > 0; })
      .sort(function (a, b) {
        return b.hits - a.hits || a.time - b.time || String(a.name).localeCompare(String(b.name));
      });
  }

  function fmt(seconds) {
    return (Math.round(seconds * 10) / 10).toFixed(1).replace('.', ',') + ' s';
  }

  return { parseAnswer: parseAnswer, rank: rank, fmt: fmt };
});
