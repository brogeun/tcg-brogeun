// Authored gameplay tuning, not canonical battle stats or real-world biology.
// Every Kanto species has an explicit row, including evolutions and encounters
// that are gated elsewhere. These profiles never change availability or rewards.
// Columns: id, locomotion, speed (m/s), rest (seconds), stride (m), altitude (m),
//          activity, habitat, resource, social.
const rows = [
 [1, 'ground', .62, 2.8, 1.9, 0, 'graze', 'forest', 'leaves', 'herd'], // Bulbasaur
 [2, 'ground', .54, 3.5, 2.0, 0, 'bask', 'forest', 'leaves', 'herd'], // Ivysaur
 [3, 'ground', .38, 5.0, 1.8, 0, 'bask', 'meadow', 'leaves', 'herd'], // Venusaur
 [4, 'ground', .68, 2.6, 1.8, 0, 'bask', 'rocky', 'minerals', 'pair'], // Charmander
 [5, 'ground', .88, 2.5, 2.3, 0, 'patrol', 'volcanic', 'minerals', 'solitary'], // Charmeleon
 [6, 'fly', 1.35, 3.1, 3.8, 1.7, 'roost', 'volcanic', 'minerals', 'solitary'], // Charizard
 [7, 'wade', .62, 2.5, 1.8, 0, 'bask', 'shore', 'shore', 'pair'], // Squirtle
 [8, 'wade', .75, 2.8, 2.1, 0, 'look', 'shore', 'water', 'pair'], // Wartortle
 [9, 'wade', .64, 3.4, 2.3, 0, 'bask', 'shore', 'water', 'solitary'], // Blastoise
 [10, 'ground', .32, 2.8, 1.1, 0, 'graze', 'canopy', 'leaves', 'pair'], // Caterpie
 [11, 'ground', .08, 16, .28, 0, 'sleep', 'canopy', 'leaves', 'solitary'], // Metapod
 [12, 'fly', .70, 2.6, 2.7, 1.0, 'forage', 'meadow', 'berries', 'flock'], // Butterfree
 [13, 'ground', .35, 2.5, 1.15, 0, 'graze', 'canopy', 'leaves', 'pair'], // Weedle
 [14, 'ground', .09, 15, .30, 0, 'sleep', 'canopy', 'leaves', 'solitary'], // Kakuna
 [15, 'fly', 1.2, 1.8, 3.0, 1.1, 'patrol', 'canopy', 'leaves', 'flock'], // Beedrill
 [16, 'fly', 1.18, 1.6, 3.0, .85, 'forage', 'meadow', 'berries', 'flock'], // Pidgey
 [17, 'fly', 1.40, 2.0, 3.5, 1.25, 'look', 'forest', 'berries', 'flock'], // Pidgeotto
 [18, 'fly', 1.75, 2.5, 4.2, 1.75, 'roost', 'canopy', 'shade', 'pair'], // Pidgeot
 [19, 'ground', 1.05, 1.3, 2.4, 0, 'forage', 'meadow', 'berries', 'herd'], // Rattata
 [20, 'ground', .90, 1.9, 2.6, 0, 'forage', 'wetland', 'berries', 'pair'], // Raticate
 [21, 'fly', 1.30, 1.5, 3.2, .9, 'look', 'meadow', 'grass', 'flock'], // Spearow
 [22, 'fly', 1.65, 2.2, 4.0, 1.55, 'patrol', 'rocky', 'shade', 'pair'], // Fearow
 [23, 'ground', .72, 3.4, 2.1, 0, 'lurk', 'undergrowth', 'shade', 'solitary'], // Ekans
 [24, 'ground', .88, 3.8, 2.5, 0, 'lurk', 'wetland', 'shade', 'solitary'], // Arbok
 [25, 'ground', 1.0, 1.7, 2.5, 0, 'forage', 'forest', 'berries', 'pair'], // Pikachu
 [26, 'ground', 1.18, 2.0, 2.9, 0, 'forage', 'forest', 'electric', 'solitary'], // Raichu
 [27, 'burrow', .58, 2.8, 1.8, 0, 'dig', 'rocky', 'minerals', 'solitary'], // Sandshrew
 [28, 'burrow', .70, 3.0, 2.2, 0, 'dig', 'rocky', 'minerals', 'solitary'], // Sandslash
 [29, 'ground', .72, 2.4, 1.9, 0, 'forage', 'meadow', 'grass', 'pair'], // Nidoran female
 [30, 'ground', .80, 2.8, 2.2, 0, 'look', 'undergrowth', 'berries', 'herd'], // Nidorina
 [31, 'ground', .72, 3.4, 2.5, 0, 'patrol', 'rocky', 'shade', 'herd'], // Nidoqueen
 [32, 'ground', .78, 2.2, 2.0, 0, 'forage', 'meadow', 'grass', 'pair'], // Nidoran male
 [33, 'ground', .95, 2.5, 2.4, 0, 'patrol', 'undergrowth', 'berries', 'pair'], // Nidorino
 [34, 'ground', .90, 3.0, 2.8, 0, 'patrol', 'rocky', 'shade', 'solitary'], // Nidoking
 [35, 'ground', .52, 3.2, 1.5, 0, 'look', 'cave', 'minerals', 'herd'], // Clefairy
 [36, 'ground', .62, 3.8, 1.8, 0, 'look', 'cave', 'shade', 'pair'], // Clefable
 [37, 'ground', .82, 2.9, 2.2, 0, 'bask', 'forest', 'shade', 'pair'], // Vulpix
 [38, 'ground', .95, 4.0, 2.7, 0, 'look', 'sanctuary', 'shade', 'solitary'], // Ninetales
 [39, 'ground', .55, 4.2, 1.6, 0, 'sleep', 'meadow', 'berries', 'herd'], // Jigglypuff
 [40, 'ground', .62, 4.5, 1.8, 0, 'look', 'forest', 'shade', 'pair'], // Wigglytuff
 [41, 'fly', .95, 2.7, 2.8, 1.35, 'roost', 'cave', 'shade', 'flock'], // Zubat
 [42, 'fly', 1.18, 3.0, 3.3, 1.65, 'roost', 'cave', 'shade', 'flock'], // Golbat
 [43, 'ground', .28, 4.8, .9, 0, 'bask', 'undergrowth', 'shade', 'herd'], // Oddish
 [44, 'ground', .24, 5.2, .85, 0, 'bask', 'undergrowth', 'shade', 'herd'], // Gloom
 [45, 'ground', .28, 4.6, 1.05, 0, 'bask', 'forest', 'shade', 'pair'], // Vileplume
 [46, 'ground', .30, 3.5, 1.0, 0, 'forage', 'undergrowth', 'shade', 'pair'], // Paras
 [47, 'ground', .33, 4.0, 1.1, 0, 'forage', 'undergrowth', 'shade', 'solitary'], // Parasect
 [48, 'ground', .55, 2.7, 1.8, 0, 'forage', 'undergrowth', 'leaves', 'pair'], // Venonat
 [49, 'fly', .82, 2.3, 2.8, 1.1, 'roost', 'canopy', 'shade', 'pair'], // Venomoth
 [50, 'burrow', .55, 2.4, 1.4, 0, 'dig', 'rocky', 'minerals', 'solitary'], // Diglett
 [51, 'burrow', .72, 2.6, 1.9, 0, 'dig', 'rocky', 'minerals', 'herd'], // Dugtrio
 [52, 'ground', .86, 2.4, 2.2, 0, 'forage', 'ruins', 'berries', 'solitary'], // Meowth
 [53, 'ground', 1.25, 3.6, 3.0, 0, 'lurk', 'forest', 'shade', 'solitary'], // Persian
 [54, 'wade', .52, 4.2, 1.7, 0, 'look', 'shore', 'shore', 'pair'], // Psyduck
 [55, 'wade', 1.0, 2.5, 2.8, 0, 'forage', 'wetland', 'water', 'pair'], // Golduck
 [56, 'ground', 1.05, 1.9, 2.8, 0, 'forage', 'forest', 'berries', 'herd'], // Mankey
 [57, 'ground', 1.2, 2.1, 3.0, 0, 'patrol', 'rocky', 'shade', 'solitary'], // Primeape
 [58, 'ground', 1.08, 2.2, 2.8, 0, 'patrol', 'meadow', 'grass', 'pair'], // Growlithe
 [59, 'ground', 1.65, 2.8, 3.8, 0, 'patrol', 'meadow', 'shade', 'pair'], // Arcanine
 [60, 'wade', .65, 2.3, 1.9, 0, 'float', 'wetland', 'water', 'herd'], // Poliwag
 [61, 'wade', .76, 2.7, 2.1, 0, 'bask', 'wetland', 'shore', 'pair'], // Poliwhirl
 [62, 'wade', .90, 3.0, 2.6, 0, 'patrol', 'shore', 'water', 'solitary'], // Poliwrath
 [63, 'ground', .32, 10, 1.0, 0, 'sleep', 'forest', 'shade', 'solitary'], // Abra
 [64, 'ground', .55, 3.5, 1.6, 0, 'look', 'ruins', 'shade', 'solitary'], // Kadabra
 [65, 'hover', .65, 3.8, 2.0, .35, 'look', 'ruins', 'shade', 'solitary'], // Alakazam
 [66, 'ground', .80, 2.5, 2.1, 0, 'look', 'rocky', 'minerals', 'herd'], // Machop
 [67, 'ground', .92, 2.4, 2.6, 0, 'patrol', 'rocky', 'minerals', 'pair'], // Machoke
 [68, 'ground', 1.05, 2.6, 2.9, 0, 'look', 'rocky', 'minerals', 'solitary'], // Machamp
 [69, 'ground', .32, 3.8, 1.1, 0, 'graze', 'undergrowth', 'leaves', 'herd'], // Bellsprout
 [70, 'ground', .24, 4.8, .9, 0, 'lurk', 'canopy', 'shade', 'solitary'], // Weepinbell
 [71, 'ground', .20, 6.0, .8, 0, 'lurk', 'canopy', 'shade', 'solitary'], // Victreebel
 [72, 'swim', .62, 2.8, 2.1, 0, 'float', 'open-water', 'water', 'flock'], // Tentacool
 [73, 'swim', .88, 3.1, 2.8, 0, 'lurk', 'open-water', 'water', 'solitary'], // Tentacruel
 [74, 'hover', .45, 2.8, 1.5, .35, 'float', 'rocky', 'minerals', 'herd'], // Geodude
 [75, 'ground', .55, 2.8, 1.6, 0, 'dig', 'rocky', 'minerals', 'herd'], // Graveler
 [76, 'ground', .68, 3.0, 1.8, 0, 'bask', 'rocky', 'minerals', 'solitary'], // Golem
 [77, 'ground', 1.65, 1.9, 3.8, 0, 'graze', 'meadow', 'grass', 'herd'], // Ponyta
 [78, 'ground', 2.05, 2.3, 4.5, 0, 'graze', 'meadow', 'grass', 'herd'], // Rapidash
 [79, 'wade', .28, 9.2, 1.1, 0, 'bask', 'shore', 'shore', 'pair'], // Slowpoke
 [80, 'wade', .26, 8.5, 1.2, 0, 'look', 'shore', 'water', 'solitary'], // Slowbro
 [81, 'hover', .70, 2.2, 2.3, 1.15, 'float', 'industrial', 'electric', 'flock'], // Magnemite
 [82, 'hover', .80, 2.6, 2.6, 1.4, 'float', 'industrial', 'electric', 'flock'], // Magneton
 [83, 'ground', .78, 2.8, 2.1, 0, 'forage', 'wetland', 'leaves', 'pair'], // Farfetch'd
 [84, 'ground', 1.50, 1.8, 3.6, 0, 'forage', 'meadow', 'grass', 'pair'], // Doduo: runs, not inferred from Flying type
 [85, 'ground', 1.85, 2.2, 4.2, 0, 'patrol', 'meadow', 'grass', 'herd'], // Dodrio
 [86, 'wade', .56, 3.6, 1.8, 0, 'bask', 'shore', 'shore', 'herd'], // Seel
 [87, 'wade', .78, 3.4, 2.5, 0, 'float', 'snow', 'water', 'pair'], // Dewgong
 [88, 'ground', .28, 4.2, 1.1, 0, 'lurk', 'wetland', 'shade', 'herd'], // Grimer
 [89, 'ground', .30, 5.0, 1.2, 0, 'lurk', 'industrial', 'shade', 'solitary'], // Muk
 [90, 'swim', .33, 4.0, 1.4, 0, 'float', 'shore', 'water', 'herd'], // Shellder
 [91, 'swim', .40, 4.8, 1.7, 0, 'lurk', 'snow', 'water', 'solitary'], // Cloyster
 [92, 'hover', .64, 3.0, 2.2, 1.0, 'lurk', 'ruins', 'shade', 'flock'], // Gastly
 [93, 'hover', .82, 3.4, 2.7, 1.3, 'lurk', 'ruins', 'shade', 'pair'], // Haunter
 [94, 'ground', 1.0, 4.0, 2.8, 0, 'lurk', 'ruins', 'shade', 'solitary'], // Gengar
 [95, 'burrow', .72, 4.2, 2.9, 0, 'dig', 'cave', 'minerals', 'solitary'], // Onix
 [96, 'ground', .52, 4.0, 1.5, 0, 'sleep', 'ruins', 'shade', 'pair'], // Drowzee
 [97, 'ground', .62, 3.8, 1.8, 0, 'look', 'ruins', 'shade', 'solitary'], // Hypno
 [98, 'wade', .70, 2.5, 1.8, 0, 'forage', 'shore', 'shore', 'herd'], // Krabby
 [99, 'wade', .64, 3.0, 2.1, 0, 'lurk', 'shore', 'shore', 'solitary'], // Kingler
 [100, 'ground', .75, 2.4, 2.3, 0, 'look', 'industrial', 'electric', 'flock'], // Voltorb
 [101, 'ground', 1.05, 1.8, 3.0, 0, 'patrol', 'industrial', 'electric', 'flock'], // Electrode
 [102, 'ground', .18, 6.0, .75, 0, 'sleep', 'canopy', 'shade', 'herd'], // Exeggcute
 [103, 'ground', .60, 4.4, 1.8, 0, 'bask', 'forest', 'grass', 'herd'], // Exeggutor
 [104, 'ground', .52, 3.8, 1.5, 0, 'look', 'cave', 'minerals', 'solitary'], // Cubone
 [105, 'ground', .68, 3.2, 1.9, 0, 'patrol', 'rocky', 'minerals', 'pair'], // Marowak
 [106, 'ground', 1.15, 2.4, 2.8, 0, 'patrol', 'rocky', 'none', 'solitary'], // Hitmonlee
 [107, 'ground', 1.05, 2.1, 2.4, 0, 'look', 'rocky', 'none', 'solitary'], // Hitmonchan
 [108, 'ground', .62, 3.6, 1.8, 0, 'forage', 'forest', 'berries', 'solitary'], // Lickitung
 [109, 'hover', .55, 3.0, 2.0, 1.0, 'float', 'industrial', 'shade', 'pair'], // Koffing
 [110, 'hover', .48, 3.6, 2.2, 1.2, 'float', 'industrial', 'shade', 'solitary'], // Weezing
 [111, 'ground', 1.2, 2.5, 3.2, 0, 'graze', 'rocky', 'minerals', 'herd'], // Rhyhorn
 [112, 'ground', .90, 3.0, 2.6, 0, 'dig', 'rocky', 'minerals', 'solitary'], // Rhydon
 [113, 'ground', .60, 3.2, 1.6, 0, 'forage', 'meadow', 'berries', 'pair'], // Chansey
 [114, 'ground', .42, 2.6, 1.4, 0, 'graze', 'undergrowth', 'leaves', 'pair'], // Tangela
 [115, 'ground', 1.1, 3.0, 2.7, 0, 'forage', 'meadow', 'berries', 'pair'], // Kangaskhan
 [116, 'swim', .65, 2.1, 1.9, 0, 'float', 'open-water', 'water', 'flock'], // Horsea
 [117, 'swim', .90, 2.5, 2.5, 0, 'look', 'open-water', 'water', 'pair'], // Seadra
 [118, 'swim', 1.0, 1.8, 2.6, 0, 'forage', 'wetland', 'water', 'flock'], // Goldeen
 [119, 'swim', 1.15, 2.1, 3.0, 0, 'forage', 'wetland', 'water', 'pair'], // Seaking
 [120, 'swim', .55, 3.4, 2.0, 0, 'float', 'shore', 'water', 'herd'], // Staryu
 [121, 'swim', .80, 2.4, 2.6, 0, 'float', 'open-water', 'water', 'solitary'], // Starmie
 [122, 'ground', .72, 3.2, 1.6, 0, 'look', 'ruins', 'none', 'pair'], // Mr. Mime
 [123, 'fly', 1.35, 2.0, 3.6, .85, 'patrol', 'forest', 'leaves', 'solitary'], // Scyther
 [124, 'ground', .55, 3.2, 1.5, 0, 'look', 'snow', 'shade', 'pair'], // Jynx
 [125, 'ground', 1.05, 2.1, 2.7, 0, 'forage', 'industrial', 'electric', 'pair'], // Electabuzz
 [126, 'ground', .72, 3.6, 2.0, 0, 'bask', 'volcanic', 'minerals', 'solitary'], // Magmar
 [127, 'ground', .85, 2.8, 2.3, 0, 'forage', 'forest', 'leaves', 'solitary'], // Pinsir
 [128, 'ground', 1.45, 2.5, 3.7, 0, 'graze', 'meadow', 'grass', 'herd'], // Tauros
 [129, 'swim', 1.1, 1.2, 2.6, 0, 'float', 'open-water', 'water', 'flock'], // Magikarp
 [130, 'swim', 1.30, 2.0, 3.8, 0, 'lurk', 'open-water', 'water', 'solitary'], // Gyarados: aquatic despite Flying type
 [131, 'swim', .65, 3.4, 2.8, 0, 'float', 'open-water', 'water', 'pair'], // Lapras
 [132, 'ground', .35, 4.0, 1.2, 0, 'look', 'ruins', 'shade', 'solitary'], // Ditto
 [133, 'ground', .85, 2.0, 2.4, 0, 'forage', 'forest', 'berries', 'pair'], // Eevee
 [134, 'wade', 1.0, 2.7, 2.7, 0, 'float', 'wetland', 'water', 'pair'], // Vaporeon
 [135, 'ground', 1.55, 1.6, 3.6, 0, 'patrol', 'meadow', 'electric', 'solitary'], // Jolteon
 [136, 'ground', .92, 3.0, 2.5, 0, 'bask', 'rocky', 'shade', 'solitary'], // Flareon
 [137, 'hover', .75, 2.6, 2.2, .65, 'look', 'industrial', 'electric', 'solitary'], // Porygon
 [138, 'wade', .28, 4.4, 1.1, 0, 'forage', 'shore', 'shore', 'pair'], // Omanyte
 [139, 'wade', .42, 4.0, 1.6, 0, 'lurk', 'shore', 'water', 'solitary'], // Omastar
 [140, 'wade', .38, 4.0, 1.3, 0, 'lurk', 'shore', 'shore', 'pair'], // Kabuto
 [141, 'wade', .90, 3.2, 2.4, 0, 'forage', 'shore', 'water', 'solitary'], // Kabutops
 [142, 'fly', 1.65, 3.0, 4.2, 1.9, 'roost', 'rocky', 'minerals', 'solitary'], // Aerodactyl
 [143, 'ground', .22, 14, 1.4, 0, 'sleep', 'forest', 'berries', 'solitary'], // Snorlax
 [144, 'fly', 1.45, 4.0, 4.0, 2.2, 'roost', 'snow', 'water', 'solitary'], // Articuno
 [145, 'fly', 1.65, 3.2, 4.4, 2.1, 'patrol', 'industrial', 'electric', 'solitary'], // Zapdos
 [146, 'fly', 1.60, 3.8, 4.2, 2.2, 'roost', 'volcanic', 'minerals', 'solitary'], // Moltres
 [147, 'wade', .55, 3.4, 2.3, 0, 'float', 'shore', 'water', 'pair'], // Dratini: water's edge, not water-only
 [148, 'wade', .72, 3.8, 2.8, 0, 'bask', 'shore', 'water', 'pair'], // Dragonair
 [149, 'fly', 1.40, 3.2, 3.8, 1.6, 'roost', 'shore', 'shore', 'pair'], // Dragonite
 [150, 'hover', .80, 5.0, 2.8, 1.2, 'look', 'sanctuary', 'none', 'solitary'], // Mewtwo
 [151, 'hover', 1.05, 2.5, 3.1, 1.0, 'float', 'sanctuary', 'shade', 'solitary'], // Mew
];

export const SPECIES_ECOLOGY = Object.freeze(Object.fromEntries(rows.map(([id, locomotion, speed, rest, stride, altitude, activity, habitat, resource, social]) => [id,
 Object.freeze({id, locomotion, speed, rest, stride, altitude, activity, habitat, resource, social}),
])));

/** A stable, immutable profile; unknown/non-Kanto ids return null. */
export function speciesEcology(id) {
 const key = typeof id === 'number' ? id : typeof id === 'string' ? Number(id) : NaN;
 return Number.isInteger(key) ? SPECIES_ECOLOGY[key] || null : null;
}
