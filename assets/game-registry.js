/* Explicit game labels and source aliases. Unknown products remain neutral TCG. */
(() => {
  'use strict';
  const games = {
    pokemon: {label:'포켓몬', sourceBrand:'pokemon', recognitionGameId:'pokemon', aliases:['포켓몬','pokémon','ポケモン']},
    onepiece: {label:'원피스', sourceBrand:'onepiece', recognitionGameId:'onepiece', aliases:['원피스','one-piece','one piece','ワンピース']},
    weiss_schwarz: {label:'바이스슈발츠', sourceBrand:'weis-schwarz', recognitionGameId:'weiss', aliases:['바이스슈발츠','weiss','weiss-schwarz','weiss schwarz','weiß schwarz','ヴァイスシュヴァルツ']},
    union_arena: {label:'유니온아레나', sourceBrand:'union-arena', recognitionGameId:'union-arena', aliases:['유니온아레나','union arena','ユニオンアリーナ']},
    dragon_ball_fusion_world: {label:'드래곤볼 퓨전월드', sourceBrand:'dragon-ball-super-card-game', recognitionGameId:'dragonball', aliases:['dragonball','dragon-ball-fusion-world','fusion world','드래곤볼 퓨전월드']},
    yugioh: {label:'유희왕', sourceBrand:'yu-gi-oh', recognitionGameId:'yugioh', aliases:['유희왕','yu gi oh','遊戯王']},
    digimon: {label:'디지몬', sourceBrand:'digimoncard', recognitionGameId:'digimon', aliases:['디지몬','digimon card game','digimon-card','デジモン']},
  };
  const flatten = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s_-]+/g,'');
  const aliases = new Map();
  Object.entries(games).forEach(([key, record]) => {
    [key,record.sourceBrand,record.recognitionGameId,...record.aliases].forEach(value => aliases.set(flatten(value),key));
    Object.freeze(record.aliases); Object.freeze(record);
  });
  const canonical = value => aliases.get(flatten(value)) || null;
  const displayOnly = new Map([
    ['riftbound','리프트바운드'], ['chiikawa','치이카와'], ['weissschwarzblau','바이스슈발츠 브라우'],
    ['dragonballheroes','드래곤볼 히어로즈'], ['nikke','니케'],
  ]);
  const api = Object.freeze({
    games:Object.freeze(games), canonical,
    label(value) { const key=canonical(value); return key ? games[key].label : displayOnly.get(flatten(value)) || 'TCG'; },
    sourceSlug(value) { const key=canonical(value); return key ? games[key].sourceBrand : null; },
    recognitionGameId(value) { const key=canonical(value); return key ? games[key].recognitionGameId : null; },
  });
  if (typeof window !== 'undefined') window.TCGGameRegistry = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
