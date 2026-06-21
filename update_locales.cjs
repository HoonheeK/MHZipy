const fs = require('fs');
const path = require('path');

const localesDir = path.join(__dirname, 'src', 'locales');
const translations = JSON.parse(fs.readFileSync(path.join(__dirname, 'translations.json'), 'utf8'));

const englishBase = translations['en'];

const files = fs.readdirSync(localesDir).filter(f => f.endsWith('.json'));

for (const file of files) {
  const lang = path.basename(file, '.json');
  const filePath = path.join(localesDir, file);
  
  let content = {};
  try {
    content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch(e) {
    console.error(`Could not read ${file}`);
    continue;
  }
  
  const transData = translations[lang] || {};
  
  // Merge keys
  for (const category of Object.keys(englishBase)) {
    if (!content[category]) content[category] = {};
    for (const key of Object.keys(englishBase[category])) {
      if (!content[category][key]) {
        if (transData[category] && transData[category][key]) {
          content[category][key] = transData[category][key];
        } else {
          content[category][key] = englishBase[category][key];
        }
      }
    }
  }
  
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
}

console.log('Locales updated successfully!');
