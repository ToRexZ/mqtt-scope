'use strict';

// Plot layouts, one per connection profile, in the profileLayouts store:
//   { version: 1, byProfile: { <profile id>: <plots document> },
//     lastUsed: <profile id>|null, legacyProfiles: [<profile id>] }
// Before 0.4.0 every profile shared one layout (plotTabs, plus the 0.1
// document plots). Those files are only read from now on: the profiles that
// existed at the upgrade (legacyProfiles) start with them, a profile made
// later with a copy of the layout opened last. Main does every
// read-modify-write here, so windows saving at the same time never undo each
// other's changes.

const VERSION = 1;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function checkId(id) {
  if (typeof id !== 'string' || !id) throw new Error('A profile id is required');
}

// stores: get(name)/set(name, value) (see jsonStore.js); profileIds(): the
// ids of the profiles saved now.
function createLayoutStore({ stores, profileIds }) {
  // The stored document with every field usable; fields a newer version
  // added are kept.
  function read() {
    const doc = stores.get('profileLayouts');
    const base = isObject(doc) ? doc : { version: VERSION };
    return {
      ...base,
      byProfile: isObject(base.byProfile) ? base.byProfile : {},
      lastUsed: typeof base.lastUsed === 'string' ? base.lastUsed : null,
      legacyProfiles: Array.isArray(base.legacyProfiles) ? base.legacyProfiles.filter((id) => typeof id === 'string') : [],
    };
  }

  const write = (doc) => stores.set('profileLayouts', doc);
  // Own keys only: an id like "constructor" names no layout.
  const layoutOf = (doc, id) => (id !== null && Object.hasOwn(doc.byProfile, id) ? doc.byProfile[id] : null);

  // Once, on the first start of a version that keeps layouts per profile.
  function migrate() {
    if (stores.get('profileLayouts') !== null) return;
    write({ version: VERSION, byProfile: {}, lastUsed: null, legacyProfiles: profileIds() });
  }

  // The layout to show for a profile, as { doc, legacy } for the plots panel
  // (legacy: the 0.1 document, for a layout of before 0.4.0).
  function get(profileId) {
    checkId(profileId);
    const doc = read();
    let res;
    if (layoutOf(doc, profileId)) res = { doc: layoutOf(doc, profileId), legacy: null };
    else if (!doc.legacyProfiles.includes(profileId) && layoutOf(doc, doc.lastUsed)) res = { doc: layoutOf(doc, doc.lastUsed), legacy: null };
    else res = { doc: stores.get('plotTabs'), legacy: stores.get('plots') };
    if (doc.lastUsed !== profileId) write({ ...doc, lastUsed: profileId });
    return res;
  }

  function set(profileId, layout) {
    checkId(profileId);
    if (!isObject(layout)) throw new Error('A plots document is required');
    const doc = read();
    // Built as entries: a key like "__proto__" stays a plain key.
    const byProfile = Object.fromEntries([...Object.entries(doc.byProfile).filter(([id]) => id !== profileId), [profileId, layout]]);
    write({ ...doc, byProfile });
    return { ok: true };
  }

  // The profiles were deleted: their layouts go too.
  function remove(ids) {
    const gone = new Set(Array.isArray(ids) ? ids : []);
    const doc = read();
    const known = (id) => Object.hasOwn(doc.byProfile, id) || doc.legacyProfiles.includes(id) || doc.lastUsed === id;
    if (![...gone].some(known)) return;
    write({
      ...doc,
      byProfile: Object.fromEntries(Object.entries(doc.byProfile).filter(([id]) => !gone.has(id))),
      lastUsed: gone.has(doc.lastUsed) ? null : doc.lastUsed,
      legacyProfiles: doc.legacyProfiles.filter((id) => !gone.has(id)),
    });
  }

  return { migrate, get, set, remove };
}

module.exports = { createLayoutStore };
