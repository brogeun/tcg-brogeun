import {configureLocale,localizeData} from './i18n.mjs';
import {World,THREE} from './world.mjs';
import {PokemonResources} from './pokemon.mjs';
import {Game} from './game.mjs';
import {UI} from './ui.mjs';
import {newSave,loadSave} from './core.mjs';
import {migrateFiveSave} from './save-migration.mjs';
import {baseComposition} from './base-layout.mjs';
import {AccountSaveUI} from './account-save-ui.mjs';
import {startRuntime,readStartupData} from './startup.mjs';
try{
 let [species,moves,biomes,chart,manifest,design,entities,messages,literals,speciesLocalized,regionsLocalized,compositions,movesLocalized]=await readStartupData(import.meta.url,['species','moves','biomes','type-chart','pokemon-manifest','game-design','locale-entities','locale-messages','locale-literals','species-localized','regions-localized','region-compositions','moves-localized']);
 const params=new URLSearchParams(location.search),qaMode=params.get('qa')==='1';
 compositions={...compositions,regions:Object.fromEntries(Object.entries(compositions.regions).map(([id,composition])=>[id,baseComposition(composition)]))};
 configureLocale({entities,messages,literals},qaMode?'ko-KR':loadSave(globalThis.localStorage,raw=>migrateFiveSave(raw,compositions))?.settings.locale||'ko-KR');localizeData({species,moves,biomes,speciesLocalized,regionsLocalized,movesLocalized});
 const world=new World(document.querySelector('#world'));
 world.compositions=compositions;
 const resources=new PokemonResources(THREE,manifest,new URL('../assets/cobblemon/',import.meta.url).href,{maxSpecies:24});
 const game=new Game(world,resources,{species,moves,biomes,chart,manifest,design,compositions,qaMode});
 // QA uses an isolated in-memory storage adapter, including checkpoints and autosaves.
 const ui=new UI(game);world.setQuality(game.save.settings.quality);
 const account=qaMode?null:new AccountSaveUI(game,ui);
 await startRuntime(game,ui,account);
 // Read-only diagnostics and explicit developer room, without save mutation shortcuts.
 window.kanto151={game,world,resources,ui,diagnostics:()=>({phase:game.phase,region:game.save.region,actors:game.wild.length,renderer:world.renderer.info,assetCount:manifest.length})};
 window.__kantoStartupState='ready';window.dispatchEvent(new CustomEvent('kanto151-ready'));
 if(new URLSearchParams(location.search).has('asset-test'))game.openPanel('assets');
}catch(error){console.error(error);const message=`탐험을 시작할 수 없습니다: ${error.message}`;window.__kantoStartupState='failed';window.__kantoStartupError=message;document.querySelector('#load-message').textContent=message;window.dispatchEvent(new CustomEvent('kanto151-startup-error',{detail:message}));}

