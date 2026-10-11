// Optional follow-up routes reuse existing terrain, species and region unlocks.
export const RUN_ENEMIES=Object.freeze({verdant:[19,16,21],waterside:[98,54,79],highlands:[74,27,66],complex:[81,100,109],caldera:[78,77,37]});
export const RUN_RULES=Object.freeze({surveySeconds:5,cooldown:300,coins:60,tokens:1,battleWaves:2});
export const REGIONAL_RUNS=Object.freeze([
 {region:'verdant',story:'forest-notes',name:'숲의 순환 탐사',hub:[-17,-15],steps:[{kind:'survey',name:'천년나무 생태 관찰',point:[-17,-15]},{kind:'relay',name:'보호구역 표식 연결',points:[[20,-19],[4,4]],limit:55},{kind:'battle',name:'초원 조사 구역 방어',speciesId:19,style:'coast-guard'},{kind:'report',name:'숲 관측 기록 제출'}]},
 {region:'waterside',story:'coast-rescue',name:'해안의 조류 탐사',hub:[22,25],steps:[{kind:'survey',name:'모래톱 물결 관찰',point:[22,25]},{kind:'battle',name:'물가 조사 구역 방어',speciesId:98,style:'coast-guard'},{kind:'relay',name:'섬과 폭포 표식 연결',points:[[14,-12],[-9,-28]],limit:65},{kind:'report',name:'해안 관측 기록 제출'}]},
 {region:'highlands',story:'cave-record',name:'산맥의 지층 탐사',hub:[12,-10],steps:[{kind:'relay',name:'협곡과 회랑 표식 연결',points:[[-13,5],[12,-10]],limit:65},{kind:'survey',name:'결정 회랑 지층 관찰',point:[12,-10]},{kind:'battle',name:'바위 조사 구역 방어',speciesId:74,style:'stone-guard'},{kind:'report',name:'산맥 관측 기록 제출'}]},
 {region:'complex',story:'generator-record',name:'연구단지 신호 탐사',hub:[16,12],steps:[{kind:'sequence',name:'변동 회로 연결',points:[[19,12],[22,12],[25,12]]},{kind:'survey',name:'안뜰 생태 신호 관찰',point:[-20,12]},{kind:'battle',name:'발전 구획 조사 방어',speciesId:81,style:'circuit-guard'},{kind:'report',name:'연구단지 관측 기록 제출'}]},
 {region:'caldera',story:'ember-route',name:'화산의 안전 동선 탐사',hub:[-13,4],steps:[{kind:'survey',name:'용암교 지열 관찰',point:[-13,4]},{kind:'relay',name:'화산 진입로 표식 연결',points:[[-22,18],[-23,-10]],limit:70},{kind:'battle',name:'잿불 조사 구역 방어',speciesId:78,style:'ember-guard'},{kind:'report',name:'화산 관측 기록 제출'}]}
]);
