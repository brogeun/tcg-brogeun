/**
 * PSA 공개 cert 페이지 HTML → cert 객체 (기존 PSA API 응답과 동일 형태)
 * cache.js (워커가 보낸 HTML 파싱) 에서 사용.
 * 라벨-값 쌍 구조: Item Grade / Brand/Title / Subject / Card Number / Variety/Pedigree / Year / Category
 */
export function parsePsaCertPage(html, certNumber) {
  const text = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ');
  const lines = text.split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const after = (label) => {
    const lab = label.toLowerCase();
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i].toLowerCase() === lab) return lines[i + 1];
    }
    return '';
  };
  const grade = after('Item Grade');
  const brand = after('Brand/Title');
  const subject = after('Subject');
  let cardNumber = after('Card Number');
  const variety = after('Variety/Pedigree');
  const year = after('Year');
  const category = after('Category');
  if (!cardNumber) {
    const m = (String(html).replace(/<[^>]+>/g, ' ').match(/#\s*(\d{1,4})\b/) || [])[1];
    if (m) cardNumber = m;
  }
  let totalPop = null;
  let popHigher = null;
  const pm = text.match(/PSA Population\s+([\d,]+)/i);
  if (pm) totalPop = parseInt(pm[1].replace(/,/g, ''), 10) || null;
  const ph = text.match(/PSA Pop Higher\s+([\d,]+)/i);
  if (ph) popHigher = parseInt(ph[1].replace(/,/g, ''), 10);

  if (!grade && !brand && !cardNumber) return null; // not found / 미파싱

  return {
    CertNumber: certNumber,
    CardGrade: grade,
    Brand: brand,
    Subject: subject,
    CardNumber: cardNumber,
    VarietyPedigree: variety,
    Year: year,
    Category: category,
    TotalPopulation: totalPop,
    PopulationHigher: popHigher,
  };
}
