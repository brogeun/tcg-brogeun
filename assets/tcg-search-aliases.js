/* Korean search spellings only: never rewrite source names, numbers or prices. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TCGSearchAliases=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const normalize=value=>String(value||'').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,'');
  const parse=text=>text.trim().split('\n').map(line=>{const [native,korean,...other]=line.split('|');return {native,korean,terms:[native,...other]};});
  const nikke=parse(`
ラピ|라피|Rapi
アニス|아니스|Anis
ネオン|네온|Neon
紅蓮|홍련|Scarlet
モダニア|모더니아|Modernia
ドロシー|도로시|Dorothy
レッドフード|레드 후드|Red Hood
スノーホワイト|스노우 화이트|Snow White
ラプンツェル|라푼젤|Rapunzel
シンデレラ|신데렐라|Cinderella
リトルマーメイド|리틀 머메이드|Little Mermaid
グレイブ|그레이브|Grave
リリーバイス|릴리바이스|Lilith|Liliweiss
ピナ|피나|Pinne
アリス|앨리스|Alice
ヘルム|헬름|Helm
プリバティ|프리바티|Privaty
リター|리타|Liter
ルピー|루피|Rupee
ブラン|블랑|Blanc
ノワール|누아르|Noir
マリアン|마리안|Marian
ウンファ|은화|Eunhwa
エマ|엠마|Emma
ベスティー|베스티|Vesti
ポリ|폴리|Poli
ミランダ|미란다|Miranda
キリ|키리|Quiry
マクスウェル|맥스웰|Maxwell
ドレイク|드레이크|Drake
ラプラス|라플라스|Laplace
エクシア|엑시아|Exia
ノベル|노벨|Novel
ドラー|도라|Dolla
ヤン|얀|Yan
アドミ|애드미|Admi
ミハラ|미하라|Mihara
ユニ|유니|Yuni
ディーゼル|디젤|Diesel
ブリッド|브리드|Brid
ソリン|솔린|Soline
センチ|센티|Centi
エピネル|에피넬|Epinel
フォルクヴァン|폴크방|Folkwang
ルドミラ|루드밀라|Ludmilla
ネヴェ|네베|Neve
ミカ|미카|Mica
ベロータ|벨로타|Belorta
ギロチン|길로틴|Guillotine
メイデン|메이든|Maiden
クロウ|크로우|Crow
ジャッカル|자칼|Jackal
バイパー|바이퍼|Viper
ビスケット|비스킷|Biscuit
ネロ|네로|Nero
レオナ|레오나|Leona
ティア|티아|Tia
ナガ|나가|Naga
マルチャーナ|마르차나|Marciana
ライ|라이|Rei
アイン|아인|Ein
ツバイ|츠바이|Zwei
キロ|킬로|Kilo
トーブ|토브|Tove
エレグ|일레그|Elegg
トロニー|트로니|Trony
クエンシー|퀀시|Quency
ギルティ|길티|Guilty
シン|신|Sin
イサベル|이사벨|Isabel
ハラン|하란|Harran
ノア|노아|Noah
ニヒリスター|니힐리스타|Nihilister
クラウン|크라운|Crown
チャイム|차임|Chime
メアリー|메어리|Mary
ペッパー|페퍼|Pepper
シュガー|슈가|Sugar
ミルク|밀크|Milk
プリム|프림|Frima
ココア|코코아|Cocoa
ソーダ|소다|Soda
エード|에이드|Ade
ノイズ|노이즈|Noise
ボリューム|볼륨|Volume
アリア|아리아|Aria
サクラ|사쿠라|Sakura
ロザンナ|로산나|Rosanna
モラン|목단|Moran
マスト|마스트|Mast
アンカー|앵커|Anchor
ベイ|베이|Bay
クレイ|클레이|Clay
ジュリア|율리아|Julia
デルタ|델타|Delta
シグナル|시그널|Signal
エーテル|에테르|Ether
ルマニ|루마니|Rumani
ユルハ|율하|Yulha
ルージュ|루주|Rouge
ファントム|팬텀|Phantom
フローラ|플로라|Flora
トリナ|트리나|Trina
モリー|모리|Mori
マナ|마나|Mana
アルカナ|아르카나|Arcana
ナユタ|나유타|Nayuta
ソラ|소라|Sora
リバーレリオ|리버렐리오|Liberalio
クラスト|크러스트|Crust
ブレッディ|브래디 브레디|Brady|Bready
イングリッド|잉그리드|Ingrid
マスタング|머스탱|Mustang
シュエン|슈엔|Syuen
シフティー|시프티|Shifty
セシル|세실|Cecil
ヨハン|요한|Johan
エイブ|에이브|Abe
トロンベ|트롬베|Trombe
N102|엔102 앤|N102
D|디|D
K|케이|K
エヌ|앤|Anne
カウンターズ|카운터스|Counters
アーク|방주|Ark
エデン|에덴|Eden
紅蓮：ブラックシャドウ|홍련 흑영
ラピ：レッドフード|라피 레드 후드
ラプンツェル：ピュアグレイス|라푼젤 퓨어 그레이스
アニス：スパークリングサマー|아니스 스파클링 서머 수니스
ネオン：ブルーオーシャン|네온 블루 오션 수네온
ヘルム：アクアマリン|헬름 아쿠아마린 수헬름
アリス：ワンダーランドバニー|앨리스 원더랜드 바니 바니앨리스
ソーダ：トゥインクルバニー|소다 트윙클링 바니 바니소다
ルドミラ：ウィンターオーナー|루드밀라 윈터 오너
ルピー：ウィンターショッパー|루피 윈터 쇼퍼
スノーホワイト：イノセントデイズ|스노우 화이트 이노센트 데이즈
プリバティ：アンカインド・メイド|프리바티 언카인드 메이드 메이드프리바티
マスト：ロマンチックメイド|마스트 로망틱 메이드
アンカー：イノセントメイド|앵커 이노센트 메이드
メイデン：アイスローズ|메이든 아이스 로즈
ギロチン：ウィンタースレイヤー|길로틴 윈터 슬레이어
エレグ：ブーム・アンド・ショック|일레그 붐 앤 쇼크
ミハラ：ボンディングチェーン|미하라 본딩 체인
ドロシー：セレンディピティ|도로시 세렌디피티
ウンファ：タクティカル・アップ|은화 택티컬 업
エマ：タクティカル・アップ|엠마 택티컬 업
ベスティー：タクティカル・アップ|베스티 택티컬 업`);
  const hololive=parse(`
ときのそら|토키노 소라|Tokino Sora
ロボ子さん|로보코 로보코씨|Robocosan|Roboco
さくらみこ|사쿠라 미코|Sakura Miko
星街すいせい|호시마치 스이세이|Hoshimachi Suisei
AZKi|아즈키|AZKi
夜空メル|요조라 멜|Yozora Mel
アキ・ローゼンタール|아키 로젠탈 아키로제|Aki Rosenthal|アキロゼ
赤井はあと|아카이 하아토 하쨔마 하짜마|Akai Haato|Haachama
白上フブキ|시라카미 후부키|Shirakami Fubuki
夏色まつり|나츠이로 마츠리|Natsuiro Matsuri
湊あくあ|미나토 아쿠아|Minato Aqua
紫咲シオン|무라사키 시온|Murasaki Shion|シオン
百鬼あやめ|나키리 아야메|Nakiri Ayame
癒月ちょこ|유즈키 초코|Yuzuki Choco
大空スバル|오오조라 스바루 오조라스바루|Oozora Subaru
大神ミオ|오오카미 미오 오카미미오|Ookami Mio
猫又おかゆ|네코마타 오카유|Nekomata Okayu
戌神ころね|이누가미 코로네|Inugami Korone
兎田ぺこら|우사다 페코라|Usada Pekora
潤羽るしあ|우루하 루시아|Uruha Rushia
不知火フレア|시라누이 후레아|Shiranui Flare
白銀ノエル|시로가네 노엘|Shirogane Noel
宝鐘マリン|호쇼 마린 호우쇼우마린|Houshou Marine
天音かなた|아마네 카나타|Amane Kanata
桐生ココ|키류 코코|Kiryu Coco
角巻わため|츠노마키 와타메|Tsunomaki Watame
常闇トワ|토코야미 토와|Tokoyami Towa
姫森ルーナ|히메모리 루나|Himemori Luna
雪花ラミィ|유키하나 라미|Yukihana Lamy
桃鈴ねね|모모스즈 네네|Momosuzu Nene
獅白ぼたん|시시로 보탄|Shishiro Botan
尾丸ポルカ|오마루 폴카|Omaru Polka
ラプラス・ダークネス|라플라스 다크니스 라프라스다크니스|La+ Darknesss|Laplus Darknesss
鷹嶺ルイ|타카네 루이|Takane Lui
博衣こより|하쿠이 코요리|Hakui Koyori
沙花叉クロヱ|사카마타 클로에|Sakamata Chloe
風真いろは|카자마 이로하|Kazama Iroha
森カリオペ|모리 칼리오페|Mori Calliope|Your Mori.
小鳥遊キアラ|타카나시 키아라|Takanashi Kiara
一伊那尓栖|니노마에 이나니스|Ninomae Ina'nis
がうる・ぐら|가우르 구라 가우루구라|Gawr Gura
ワトソン・アメリア|왓슨 아멜리아 아멜리아왓슨|Watson Amelia
IRyS|아이리스|IRyS
九十九佐命|츠쿠모 사나|Tsukumo Sana
セレス・ファウナ|세레스 파우나|Ceres Fauna
オーロ・クロニー|오로 크로니|Ouro Kronii
七詩ムメイ|나나시 무메이|Nanashi Mumei
ハコス・ベールズ|하코스 벨즈|Hakos Baelz
アユンダ・リス|아윤다 리스|Ayunda Risu
ムーナ・ホシノヴァ|무나 호시노바|Moona Hoshinova
アイラニ・イオフィフティーン|아이라니 이오피프틴 이오피|Airani Iofifteen
クレイジー・オリー|쿠레이지 올리 크레이지올리|Kureiji Ollie
アーニャ・メルフィッサ|아냐 멜핏사 아냐멜피사|Anya Melfissa
パヴォリア・レイネ|파볼리아 레이네|Pavolia Reine
ベスティア・ゼータ|베스티아 제타|Vestia Zeta
カエラ・コヴァルスキア|카엘라 코발스키아|Kaela Kovalskia
こぼ・かなえる|코보 카나에루|Kobo Kanaeru
友人A|친구 에이 에이짱|A-chan|えーちゃん
春先のどか|하루사키 노도카|Harusaki Nodoka
あん肝|안키모|Ankimo`);
  const scopes={nikke:{aliases:'니케 승리의 여신 니케 NIKKE Goddess of Victory 勝利の女神',entries:nikke},hololive:{aliases:'홀로라이브 홀로 라이브 hololive ホロライブ',entries:hololive}};
  const compiled=new Map();
  for(const entry of [...nikke,...hololive])compiled.set(entry,entry.terms.map(term=>/^[\x00-\x7f]+$/.test(term)?
    new RegExp('(^|[^a-z0-9])'+term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[^a-z0-9])'):normalize(term)));
  function scope(item){const code=String(item.fullCardNumber||item.code||item.setCode||'');const title=[item.series,item.seriesId,item.sourcePackTitle,item.name].join(' ');
    if(/(?:^|[/_-])NIK(?:[/_-]|$)/i.test(code)||/\bnikke\b|勝利の女神|니케/i.test(title))return 'nikke';
    if(/^HOL\//i.test(code)||/\bhololive\b|ホロライブ|홀로라이브/i.test(title))return 'hololive';return '';}
  function aliases(item){const s=scopes[scope(item)];if(!s)return '';const name=String(item.name||'').normalize('NFKC').toLowerCase();const compact=normalize(name),hits=[];
    for(const entry of s.entries)if(compiled.get(entry).some(term=>typeof term==='string'?compact.includes(term):term.test(name)))hits.push(entry);
    // A shorter name contained in another character name is not an alias of it.
    const precise=hits.filter(e=>!hits.some(other=>other!==e&&normalize(other.native).includes(normalize(e.native))&&normalize(other.native)!==normalize(e.native)));
    return [s.aliases,...precise.map(e=>e.korean)].join(' ');}
  function text(item){return [item.name,item.nameKo,item.fullCardNumber,item.code,item.series,item.seriesId,item.sourcePackTitle,item.snkrProduct?.name,aliases(item)].filter(Boolean).join(' ');}
  return Object.freeze({aliases,text,scope,normalize,entries:Object.freeze({nikke,hololive})});
});
