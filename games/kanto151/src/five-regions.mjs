// Stable compatibility vocabulary. Old geometry is deliberately not stored here.
export const REGION_GROUPS={verdant:['camp','grassland','forest','safari'],waterside:['lake','coast','wetland'],highlands:['mountain','cave','frozen'],caldera:['volcano'],complex:['ruins','powerplant','laboratory']};
export const REGION_IDS=Object.keys(REGION_GROUPS);
export const LEGACY_REGION=Object.fromEntries(Object.entries(REGION_GROUPS).flatMap(([id,old])=>old.map(k=>[k,id])));
export const REGION_NAMES={verdant:{ko:'푸른잎 탐험지',en:'Verdant Expedition'},waterside:{ko:'물빛 해안',en:'Waterside Coast'},highlands:{ko:'달오름 산맥',en:'Moonrise Highlands'},caldera:{ko:'잿불 분화구',en:'Ember Caldera'},complex:{ko:'폐허 연구단지',en:'Ruined Research Complex'}};
export const LANDMARK_IDS={verdant:['verdant-camp','verdant-meadow','verdant-elder','verdant-reserve'],waterside:['waterside-pool','waterside-beach','waterside-island','waterside-falls'],highlands:['highlands-ascent','highlands-ravine','highlands-cave','highlands-summit'],caldera:['caldera-approach','caldera-bridge','caldera-sanctuary'],complex:['complex-courtyard','complex-generator','complex-lab','complex-containment']};
export const LEGACY_LANDMARK_ROLE={camp:'verdant-camp',grassland:'verdant-meadow',forest:'verdant-elder',safari:'verdant-reserve',lake:'waterside-pool',coast:'waterside-beach',wetland:'waterside-falls',mountain:'highlands-ascent',cave:'highlands-cave',frozen:'highlands-summit',volcano:'caldera-sanctuary',ruins:'complex-courtyard',powerplant:'complex-generator',laboratory:'complex-lab'};
export const SHORTCUT_IDS={'forest-vinecut':'verdant-vinecut','lake-islandcross':'waterside-islandcross','mountain-fossilbreak':'highlands-fossilbreak','mountain-clifflift':'highlands-clifflift','cave-lantern-gallery':'highlands-lantern-gallery','safari-logpush':'verdant-logpush'};
export const FIVE_WORLD='kanto-five-v1';
export const mapRegion=id=>LEGACY_REGION[id]||id;
