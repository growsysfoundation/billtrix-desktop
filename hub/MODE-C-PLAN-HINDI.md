# Mode C — Local Hub (दुकान के अंदर, बिना इंटरनेट के कई counters)

## कैसे काम करेगा
- दुकान का **एक कंप्यूटर = Hub**: उस पर BillTrix Desktop में **"Hub mode"** चालू होगा
- बाकी counters (कंप्यूटर या फ़ोन) दुकान के Wi-Fi पर `http://<hub-ip>:18300` से BillTrix खोलेंगे
- हर बिल और stock का बदलाव **तुरंत Hub पर** जाएगा, इसलिए सब counters पर एक जैसा stock दिखेगा, बिना इंटरनेट के भी
- इंटरनेट आते ही Hub अपने बदलाव **एक-एक upload में cloud पर** भेजेगा, और cloud से दूसरे devices के बदलाव लाएगा

## हिस्से
| # | हिस्सा | स्थिति |
|---|---|---|
| C1 | **Hub core**: cloud वाले नियम (revision, stock +/−, counter max, बिल-नंबर टकराव), cloud को भेजने की कतार, जवाब खो जाए तो दोबारा न भेजना, disk पर सुरक्षित | ✅ बना, 24/24 test पास |
| C2 | Hub का LAN server (port 18300): BillTrix app देना, `/api/tenant/:id/changes`, shop load | ⏳ अगला |
| C3 | Counters का login Hub पर (Hub owner के login से जुड़ा; इंटरनेट न हो तो Hub खुद जाँचे) | ⏳ |
| C4 | Hub ↔ cloud sync loop (हर 15 सेकंड, सिर्फ़ इंटरनेट होने पर) | ⏳ (logic C1 में तैयार) |
| C5 | Desktop App में "Hub mode" स्विच + counters के लिए पता/QR दिखाना | ⏳ |
| C6 | पूरा test: 1 Hub + 2 counters, इंटरनेट बंद → बिक्री → इंटरनेट चालू → cloud में सही | ⏳ |

## सीमाएँ (जानबूझकर)
- **Users/पासवर्ड बदलना** सिर्फ़ इंटरनेट पर (cloud में): Hub पर यह मना है
- बिल-नंबर टकराए तो वही नियम लगेगा जो cloud में है (अगला खाली नंबर)
