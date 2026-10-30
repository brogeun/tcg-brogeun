/* Lossless decoder for the versioned collection catalogue's packed-v1 shards. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CollectionCatalogCodec = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function decodeShard(payload) {
    if (!payload || payload.schemaVersion !== 1 || typeof payload.version !== 'string') throw new Error('Invalid collection catalogue shard');
    if (Array.isArray(payload.cards)) return payload;
    if (payload.format !== 'packed-v1' || !Array.isArray(payload.fields) || !Array.isArray(payload.rows)) throw new Error('Unsupported collection catalogue format');
    const fields = payload.fields, defaults = payload.defaults || {}, dictionaries = payload.dictionaries || {}, prefixes = payload.imagePrefixes || [], references = payload.references || {};
    if (fields.some(field => typeof field !== 'string' || field === '__proto__' || field === 'constructor' || field === 'prototype')) throw new Error('Invalid catalogue field');
    const cards = payload.rows.map(row => {
      if (!Array.isArray(row) || row.length > fields.length) throw new Error('Invalid packed card row');
      const card = {};
      for (const field of Object.keys(defaults)) card[field] = Array.isArray(defaults[field]) ? defaults[field].slice() : defaults[field];
      fields.forEach((field, index) => {
        let value = row[index];
        if (value == null) { if (field === 'image') card.image = null; return; }
        if (typeof references[field] === 'string' && value === -1) {
          if (!Object.prototype.hasOwnProperty.call(card, references[field])) throw new Error('Invalid catalogue field reference');
          value = card[references[field]];
        } else if (Array.isArray(dictionaries[field]) && Number.isInteger(value)) {
          if (value < 0 || value >= dictionaries[field].length) throw new Error('Invalid catalogue dictionary index');
          value = dictionaries[field][value];
        }
        if (field === 'image' && typeof value === 'string' && /^~\d+:/.test(value)) {
          const match = value.match(/^~(\d+):(.*)$/s), prefix = prefixes[Number(match[1])];
          if (typeof prefix !== 'string') throw new Error('Invalid image prefix');
          value = prefix + match[2];
        }
        card[field] = value;
      });
      return card;
    });
    return {schemaVersion: 1, version: payload.version, cards};
  }
  return {decodeShard};
});
