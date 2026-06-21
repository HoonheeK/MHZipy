import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import ar from './locales/ar.json';
import bn from './locales/bn.json';
import cs from './locales/cs.json';
import de_AT from './locales/de-AT.json';
import de from './locales/de.json';
import el from './locales/el.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import id from './locales/id.json';
import it from './locales/it.json';
import ja from './locales/ja.json';
import km from './locales/km.json';
import ko from './locales/ko.json';
import lo from './locales/lo.json';
import mn from './locales/mn.json';
import ms from './locales/ms.json';
import my from './locales/my.json';
import pl from './locales/pl.json';
import ru from './locales/ru.json';
import th from './locales/th.json';
import tr from './locales/tr.json';
import vi from './locales/vi.json';
import yue from './locales/yue.json';
import zh_TW from './locales/zh-TW.json';
import zh from './locales/zh.json';

const resources = {
  'ar': { translation: ar },
  'bn': { translation: bn },
  'cs': { translation: cs },
  'de-AT': { translation: de_AT },
  'de': { translation: de },
  'el': { translation: el },
  'en': { translation: en },
  'es': { translation: es },
  'fr': { translation: fr },
  'id': { translation: id },
  'it': { translation: it },
  'ja': { translation: ja },
  'km': { translation: km },
  'ko': { translation: ko },
  'lo': { translation: lo },
  'mn': { translation: mn },
  'ms': { translation: ms },
  'my': { translation: my },
  'pl': { translation: pl },
  'ru': { translation: ru },
  'th': { translation: th },
  'tr': { translation: tr },
  'vi': { translation: vi },
  'yue': { translation: yue },
  'zh-TW': { translation: zh_TW },
  'zh': { translation: zh },
};

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: 'en', // Default language
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false // React already safes from xss
    }
  });

export default i18n;
