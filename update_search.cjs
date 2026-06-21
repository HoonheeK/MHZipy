const fs = require('fs');

function replaceFile(path, replaces) {
  let content = fs.readFileSync(path, 'utf8');
  for (const [from, to] of replaces) {
    content = content.split(from).join(to);
  }
  fs.writeFileSync(path, content);
}

const searchReplaces = [
  ['Quick Access Folder Search', '{t(\'search.title\', { defaultValue: \'Quick Access Folder Search\' })}'],
  ['Intelligent File Search', '{t(\'search.subtitle\', { defaultValue: \'Intelligent File Search\' })}'],
  ['⚡ MFT Index', '⚡ {t(\'search.mftIndex\', { defaultValue: \'MFT Index\' })}'],
  ['📂 Folder', '📂 {t(\'search.folder\', { defaultValue: \'Folder\' })}'],
  ['<span>⚙️ Filter Settings</span>', '<span>⚙️ {t(\'search.filterSettings\', { defaultValue: \'Filter Settings\' })}</span>'],
  ['📂 File Type', '📂 {t(\'search.fileType\', { defaultValue: \'File Type\' })}'],
  ['⚖️ File Size', '⚖️ {t(\'search.fileSize\', { defaultValue: \'File Size\' })}'],
  ['📅 Date Modified (After)', '📅 {t(\'search.dateModifiedAfter\', { defaultValue: \'Date Modified (After)\' })}'],
  ['📅 Date Modified (Before)', '📅 {t(\'search.dateModifiedBefore\', { defaultValue: \'Date Modified (Before)\' })}'],
  ['? \'📂 Select folder to search (includes Quick Access)...\'', '? \'📂 \' + t(\'search.selectFolder\', { defaultValue: \'Select folder to search (includes Quick Access)...\' })'],
  ['+ Browse other folders...', '+ {t(\'search.browseFolders\', { defaultValue: \'Browse other folders...\' })}'],
  ['🔍 Searching for ', '🔍 {t(\'search.searchingFor\', { defaultValue: \'Searching for\' })} '],
  ['✅ Search results:', '✅ {t(\'search.searchResults\', { defaultValue: \'Search results:\' })}'],
  ['</span> items<', '</span> {t(\'search.items\', { defaultValue: \'items\' })}<'],
  ['Enter a query to start searching', '{t(\'search.enterQuery\', { defaultValue: \'Enter a query to start searching\' })}']
];

replaceFile('src/SearchView/SearchView.tsx', searchReplaces);
