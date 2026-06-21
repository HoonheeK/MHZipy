const fs = require('fs');

function replaceFile(path, replaces) {
  let content = fs.readFileSync(path, 'utf8');
  for (const [from, to] of replaces) {
    content = content.split(from).join(to);
  }
  fs.writeFileSync(path, content);
}

const explorerReplaces = [
  ['<span>Quick Access</span>', '<span>{t(\'explorer.quickAccess\', { defaultValue: \'Quick Access\' })}</span>'],
  ['<span style={{ fontSize: \'0.9em\' }} >Filter Tree</span>', '<span style={{ fontSize: \'0.9em\' }} >{t(\'explorer.filterTree\', { defaultValue: \'Filter Tree\' })}</span>'],
  ['<span>Remove from Quick Access</span>', '<span>{t(\'contextMenu.removeFromQuickAccess\', { defaultValue: \'Remove from Quick Access\' })}</span>'],
  ['<span>Cut</span> <span className="shortcut">', '<span>{t(\'contextMenu.cut\', { defaultValue: \'Cut\' })}</span> <span className="shortcut">'],
  ['<span>Copy</span> <span className="shortcut">', '<span>{t(\'contextMenu.copy\', { defaultValue: \'Copy\' })}</span> <span className="shortcut">'],
  ['<span>Create Folder</span>', '<span>{t(\'contextMenu.createFolder\', { defaultValue: \'Create Folder\' })}</span>'],
  ['<span>Paste</span> <span className="shortcut">', '<span>{t(\'contextMenu.paste\', { defaultValue: \'Paste\' })}</span> <span className="shortcut">'],
  ['<span>Open in New Window</span> <span className="shortcut">', '<span>{t(\'contextMenu.openInNewWindow\', { defaultValue: \'Open in New Window\' })}</span> <span className="shortcut">'],
  ['Open in File Explorer\r\n                </div>', '{t(\'contextMenu.openInExplorer\', { defaultValue: \'Open in File Explorer\' })}\r\n                </div>'],
  ['Open in File Explorer\n                </div>', '{t(\'contextMenu.openInExplorer\', { defaultValue: \'Open in File Explorer\' })}\n                </div>'],
  ['<span>Delete</span> <span className="shortcut">', '<span>{t(\'contextMenu.delete\', { defaultValue: \'Delete\' })}</span> <span className="shortcut">'],
  ['>Set as Default Folder</div>', '>{t(\'contextMenu.setAsDefaultFolder\', { defaultValue: \'Set as Default Folder\' })}</div>'],
  ['>\r\n                  Add to Quick Access\r\n                </div>', '>\r\n                  {t(\'contextMenu.addToQuickAccess\', { defaultValue: \'Add to Quick Access\' })}\r\n                </div>'],
  ['>\n                  Add to Quick Access\n                </div>', '>\n                  {t(\'contextMenu.addToQuickAccess\', { defaultValue: \'Add to Quick Access\' })}\n                </div>'],
  ['>Set as Editable</div>', '>{t(\'contextMenu.setAsEditable\', { defaultValue: \'Set as Editable\' })}</div>'],
  ['>Set as Read-only</div>', '>{t(\'contextMenu.setAsReadOnly\', { defaultValue: \'Set as Read-only\' })}</div>'],
  ['>Clear Permission</div>', '>{t(\'contextMenu.clearPermission\', { defaultValue: \'Clear Permission\' })}</div>']
];

replaceFile('src/FileExplorer/FileExplorer.tsx', explorerReplaces);
