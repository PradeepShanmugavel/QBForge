import * as XLSX from 'xlsx';

const SKIP_HEADERS = new Set(['name', 'qb name', 'question bank', 'qb', 'title', 's.no', 'sno', 'sl no']);

export function parseExcelFile(file) {
  return new Promise((resolve, reject) => {
    const ext    = file.name.split('.').pop().toLowerCase();
    const reader = new FileReader();

    reader.onerror = () => reject(new Error('Could not read file'));

    reader.onload = (e) => {
      try {
        let names = [];

        if (ext === 'csv') {
          const text = e.target.result;
          names = text
            .split('\n')
            .map(row => row.split(',')[0].replace(/^["']|["']$/g, '').trim())
            .filter(n => n && !SKIP_HEADERS.has(n.toLowerCase()));
        } else {
          const data = new Uint8Array(e.target.result);
          const wb   = XLSX.read(data, { type: 'array' });
          const ws   = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

          names = rows
            .map(r => String(r[0] || '').trim())
            .filter(n => n && !SKIP_HEADERS.has(n.toLowerCase()));
        }

        if (!names.length) {
          reject(new Error('No QB names found. Make sure the first column has QB names.'));
        } else {
          resolve([...new Set(names)]); // deduplicate
        }
      } catch (err) {
        reject(new Error('Failed to parse file: ' + err.message));
      }
    };

    if (ext === 'csv') {
      reader.readAsText(file);
    } else {
      reader.readAsArrayBuffer(file);
    }
  });
}
