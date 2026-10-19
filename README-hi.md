# 天机阁 · एल्गोरिदम कोडेक्स

> [English](README.md) · [中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

Tianjige एक DeepSeek Harness प्लगइन है जो व्यक्तिगत *एल्गोरिदम कोडेक्स* को ऐसी चीज़ बना देता है
जिसे एजेंट सीधे खोज सके: **13 डोमेन** (रेंडरिंग, ज्यामिति, neural-3d, एनिमेशन, भौतिकी, प्रोसीजरल,
ऑडियो, ai-ml, भीड़, गेम सिस्टम, संख्यात्मक गणित, पाइपलाइन, टूलिंग) में **219 एल्गोरिदम**, हर एक के
साथ वास्तविक कार्यशील इम्प्लीमेंटेशन का लिंक — और इंसानों के लिए एक पढ़ने योग्य साइडबार पेज।

प्लगइन केवल *इंटरफ़ेस* है; कोडेक्स ऊपरी स्तर के `algo-hub` रिपॉज़िटरी में रहता है
(`data/algorithms.json` + `data/taxonomy.json`)। पैकेज में कोई डेटा नहीं है, इसलिए एक ही इंस्टॉल
किसी भी डेटा डायरेक्टरी के लिए काम करता है।

## Features

- **खोज** — `tianji_search` प्राकृतिक भाषा या कीवर्ड से एल्गोरिदम ढूँढता है, डोमेन, फ़ंक्शन-की,
  परिपक्वता और «तैयार इम्प्लीमेंटेशन है» के फ़िल्टर के साथ। पहले सटीक मिलान, फिर आंशिक; परिणाम में
  क्लिक करने योग्य रेपो/पैकेज लिंक।
- **फ़ाइल** — `tianji_get` पूरी प्रविष्टि देता है: कैसे काम करता है, समझौते, जटिलता, पेपर,
  इम्प्लीमेंटेशन, उसी कार्य के अन्य विकल्प और चेतावनियाँ।
- **पूछें** — `tianji_ask` डिज़ाइन-प्रश्न का उत्तर पहले कोडेक्स से देता है, और `findNew: true` पर
  बाहर के एल्गोरिदम वेब पर खोजता है।
- **स्वीप** — `tianji_sweep` वेब पर नए एल्गोरिदम खोजता है, उन्हें `data/pending/` में ड्राफ़्ट
  बनाता है, और रोज़ाना चल सकता है (`action=status|start|config`)।
- **क्यूरेशन** — `tianji_stage` / `tianji_update` / `tianji_review` / `tianji_review_mark` /
  `tianji_stats` / `tianji_usage` जोड़ना, संपादन, समीक्षा, ऑडिट और टोकन-लेखा संभालते हैं।
- **इंटरफ़ेस** — बाएँ साइडबार की एक पंक्ति पूरा पेज खोलती है जिसमें चार टैब हैं
  (कोडेक्स / अखाड़ा / स्वीप / पूछें); वही पेज दाएँ साइडबार टैब के रूप में भी उपलब्ध है।

## Install

पैकेज `tianjige-plugin/` डायरेक्टरी है। इसे DSH प्रोफ़ाइल में इंस्टॉल करें और सक्षम करें:

```powershell
# npm से (प्रकाशित पैकेज)
dsh plugin --profile web add dsh-tianjige

# या पैक किए गए tarball से
dsh plugin --profile web add ./dsh-tianjige-<version>.tgz

# विकल्प 1 — plugin_manager टूल
#   action=install_bundle, target=link:C:/path/to/algo-hub/tianjige-plugin
# विकल्प 2 — प्रोफ़ाइल package.json में link: निर्भरता + dsh.profile.bundles प्रविष्टि
```

इसके बाद **DSH रीस्टार्ट करें**: होस्ट हिस्सा स्टार्टअप पर केवल एक बार import होता है, पेज रीफ़्रेश
उसे दोबारा लोड नहीं करता। रीस्टार्ट से पहले `node --check host.js` और `node --check lib/*.mjs`
से जाँच सकते हैं।

## Configuration

प्लगइन `cordis.patch.yml` के ज़रिए एक पंक्ति (`id: tianjige`) जोड़ता है। दोनों कुंजियाँ वैकल्पिक हैं:

| कुंजी | डिफ़ॉल्ट | अर्थ |
|---|---|---|
| `dataDir` | इस पैकेज की मूल डायरेक्टरी (= रिपॉज़िटरी रूट) | कोडेक्स रूट जिसमें `data/` और `server/ai.mjs` हैं |
| `defaultLimit` | `8` | `tianji_search` की डिफ़ॉल्ट पंक्तियाँ |

```yaml
- insert:
    - id: tianjige
      name: dsh-tianjige
      config:
        dataDir: D:\wherever\algo-hub   # वैकल्पिक, डिफ़ॉल्ट रूप से अनुमानित
        defaultLimit: 8
```

## Data layout

```
algo-hub/
  data/
    algorithms.json   # मर्ज किया गया कोडेक्स (219 प्रविष्टियाँ)
    taxonomy.json     # 13 डोमेन
    review.json       # समीक्षा लेजर
    coverage.json     # स्वीप कवरेज मैट्रिक्स
    staging/          # प्रति-एजेंट सामग्री, मर्ज की प्रतीक्षा में
    pending/          # AI ड्राफ़्ट, मानव समीक्षा की प्रतीक्षा में
    runs/             # हर स्वीप का लेजर
    logs/             # पेज त्रुटियाँ (client-YYYY-MM-DD.log)
  server/ai.mjs       # पुराने वेब संस्करण का AI तर्क (प्लगइन lib/ai.mjs इस्तेमाल करता है)
  tools/algohub.py    # CLI: validate / merge / export / stats / coverage / record-run / snapshot …
```

npm से इंस्टॉल होने पर पैकेज के आसपास कोई रिपॉज़िटरी नहीं होती, इसलिए पहला रन बंडल की गई स्टार्टर लाइब्रेरी (`seed/algorithms.json`, `seed/taxonomy.json`) को `~/.dsh/tianjige` में कॉपी करता है और सारी राइटिंग वहीं रहती है। `dataDir` (या `DSH_TIANJIGE_DATA_DIR`) इसे बदल सकता है; link / development इंस्टॉल रिपॉज़िटरी रूट ही इस्तेमाल करता है।

## Compatibility

- **DSH** `>=0.2.1-rc.2` (`dsh.engines.dsh`), **Node** `^22.19.0 || >=24.0.0`
- `@deepseek-ai/*` पर कोई निर्भरता नहीं: होस्ट एंट्री शून्य import है और डेटा व AI परतें डायनामिक
  import से लोड होती हैं, इसलिए प्रोफ़ाइल में मौजूद कोई प्रति रनटाइम संस्करण को छिपा नहीं सकती।
- AI टूल (पूछें / स्वीप / सहायक समीक्षा) के लिए `DEEPSEEK_API_KEY` चाहिए: एनवायरनमेंट वेरिएबल या
  `~/.dsh/.credentials.yaml` में `DEEPSEEK_API_KEY:` पंक्ति। कुंजी के बिना बाकी टूल चलते रहते हैं और
  AI टूल `AI_NO_KEY` लौटाते हैं।
- एकमात्र peer निर्भरता `react` है (क्लाइंट हिस्सा, हार्नेस देता है)।

## Tools

| टूल | कार्य |
|---|---|
| `tianji_search` | प्रविष्टियाँ खोजें (`query`, वैकल्पिक `domain` / `functionKey` / `maturity` / `hasImpl` / `limit`) |
| `tianji_get` | `id` से पूरी फ़ाइल |
| `tianji_ask` | प्राकृतिक भाषा में डिज़ाइन प्रश्न (`task`, वैकल्पिक `findNew`) |
| `tianji_sweep` | स्वीप: `action=status` / `start` / `config` (रोज़ाना स्वचालित) |
| `tianji_stage` | नया उम्मीदवार जोड़ें (`data/staging/`, मानव मर्ज की प्रतीक्षा) |
| `tianji_update` | मौजूदा प्रविष्टि संपादित करें (स्वचालित बैकअप) |
| `tianji_review` / `tianji_review_mark` | समीक्षा कतार: सूची / निर्णय दर्ज |
| `tianji_stats` | ऑडिट: प्रविष्टि गणना, डोमेन वितरण, इम्प्लीमेंटेशन कवरेज, समीक्षा प्रगति |
| `tianji_usage` | AI टोकन लेजर (पढ़ें / हटाएँ / साफ़ करें / रिटेंशन) |

## UI surfaces

प्लगइन तीन स्थान पंजीकृत करता है:

- `sidebar.panellist` — बाएँ साइडबार में एक पंक्ति «天机阁» (`order: 120`)
- `main` — उस पंक्ति से खुलने वाला पूरा पेज (टैब: कोडेक्स / अखाड़ा / स्वीप / पूछें)
- `sidebar.right.pane.tab` — वही पेज दाएँ साइडबार टैब के रूप में

पेज का डेटा होस्ट रूट `/api/tianjige/{library,meta,sweep,ask,review,usage,write,log}` से जाता है,
जो केवल लूपबैक अनुरोध स्वीकार करते हैं। `webServer` सेवा न होने पर प्लगइन «केवल टूल, पेज नहीं»
पर उतर जाता है।

## Troubleshooting

- **इंस्टॉल के बाद कुछ नहीं दिखता** — पहले DSH रीस्टार्ट करें; फिर `plugin_manager` के `application`
  फ़ील्ड को देखें।
- **पेज कहता है «स्वीप स्थिति उपलब्ध नहीं»** — सामान्यतः कोई निर्भर मॉड्यूल लोड नहीं हुआ (जैसे
  `lib/ai.mjs` गायब); रूट त्रुटि को `/api/tianjige/meta` के 500 उत्तर में लिखता है।
  `node --check lib/sweep.mjs` से जाँचें।
- **`tianji_ask` में `AI_NO_KEY`** — Compatibility के अनुसार कुंजी सेट करें।
- **डेटा सत्यापन** — `python tools/algohub.py validate` (0 त्रुटि, 0 चेतावनी) और `doctor`।

## Development

- होस्ट: `host.js` (एंट्री, टूल + रूट), `lib/sweep.mjs` (स्वीप / समीक्षा / पूछें), `lib/ai.mjs`
  (AI कॉल और प्रॉम्प्ट), `lib/usage.mjs` (टोकन लेजर), `lib/entries.mjs` (प्रविष्टि पढ़ना/लिखना)।
- क्लाइंट: `lib/client.js` (React, एकल-फ़ाइल बंडल, slot में पंजीकृत)।
- परीक्षण: `npm test` → `node --test test/smoke.test.mjs` — ऑफ़लाइन, शून्य निर्भरता,
  `test/fixtures/` पर; असली डेटा को नहीं छूता और प्लगइन इंस्टॉल करने की ज़रूरत नहीं।
- स्थिर जाँच: `dsh-plugin-dev check --strict` (`dsh-plugin-guide` स्किल पैकेज) और हर एंट्री पर
  `node --check`।

## License

MIT — देखें [LICENSE](LICENSE)।
