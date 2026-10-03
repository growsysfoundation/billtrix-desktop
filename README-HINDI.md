# BillTrix Desktop (Windows app): बनाने और बाँटने की गाइड

यह फ़ोल्डर BillTrix का **Windows program** है: `.exe` installer, Desktop/Start Menu icon, अपनी window, और **Print Agent अंदर ही**।
Features और डेटा cloud से आते हैं, इसलिए हर नया फ़ीचर इसमें अपने-आप पहुँचता है।

---

## `.exe` बनाने के दो तरीक़े

### तरीक़ा A: GitHub से (कंप्यूटर पर कुछ install नहीं करना) ⭐
1. **github.com** पर मुफ़्त account बनाएँ, फिर **New repository** → नाम `billtrix-desktop` → **Private** → Create
2. Repository में **"uploading an existing file"** दबाएँ → इस फ़ोल्डर की **सारी फ़ाइलें और फ़ोल्डर** खींचकर डालें (`.github` फ़ोल्डर भी) → **Commit**
3. ऊपर **Actions** टैब → **"Build BillTrix for Windows"** → **Run workflow**
4. 5–8 मिनट बाद वही run खोलें → नीचे **Artifacts** → **BillTrix-Setup** download करें
5. उसके अंदर **`BillTrix-Setup-1.0.0.exe`** मिलेगा

### तरीक़ा B: अपने Windows कंप्यूटर पर
1. **https://nodejs.org** से **Node.js LTS** install करें
2. इस फ़ोल्डर में **Shift + Right-click → "Open in Terminal"**
3. यह चलाएँ:
   ```
   npm install
   npm run dist
   ```
4. **`dist\BillTrix-Setup-1.0.0.exe`** बन जाएगा

> सिर्फ़ चलाकर देखना हो (installer के बिना), तो `npm install` के बाद `npm start` चलाएँ।

---

## दुकान पर install करना
1. `BillTrix-Setup-1.0.0.exe` चलाएँ
2. Windows **"Windows protected your PC"** दिखाए, तो **More info → Run anyway** दबाएँ। यह इसलिए आता है क्योंकि installer पर अभी **Code Signing Certificate** नहीं है।
3. Install → Desktop पर **BillTrix** icon
4. पहली बार **इंटरनेट के साथ** खोलें और login करें। उसके बाद offline भी चलेगा।

**पुराना Print Agent (`.bat`) लगा हो तो?** कोई दिक़्क़त नहीं। Desktop App पहले से चल रहे agent को पहचानकर उसी को इस्तेमाल करेगा।

---

## App में क्या-क्या है
| सुविधा | कहाँ |
|---|---|
| Menu | **Alt** दबाएँ → BillTrix / View / Help |
| Windows के साथ अपने-आप चालू | BillTrix → **Start with Windows** ✓ |
| Print helper दोबारा चालू | BillTrix → **Restart print helper** |
| Zoom | Ctrl + = / Ctrl + − (याद रहता है) |
| पूरी स्क्रीन | F11 |
| Refresh / कैश साफ़ करके refresh | F5 / Ctrl + Shift + R |
| Voice billing माइक | अपने-आप अनुमति (सिर्फ़ BillTrix के लिए) |
| WhatsApp, Maps, दूसरी वेबसाइटें | आपके सामान्य browser में खुलेंगी |
| इंटरनेट न हो, पहली बार | "इंटरनेट नहीं मिल रहा" पेज + **Try again**, और इंटरनेट आते ही अपने-आप खुलेगा |

---

## Updates (अब पूरी तरह अपने-आप)
- **Features**: अपने-आप, cloud से (Releases पेज से नियंत्रित)।
- **Desktop खोल (.exe)**:
  1. GitHub → `package.json` में `"version"` बढ़ाएँ (जैसे `1.0.3`) → Commit
  2. Actions → **Build BillTrix for Windows** → **Run workflow** (✓ "Send this version to all shops")
  3. बस! Build ख़ुद installer को **BillTrix server पर भेज देता है** (GitHub की अपनी पहचान से — कोई पासवर्ड/चाबी नहीं), और दुकानों के app अगली बार खुलने पर (या 6 घंटे में) **"Restart now / Later"** पूछेंगे।
- चाहें तो **Super Admin → Desktop App** से हाथ से भी upload कर सकते हैं।
- दुकानों के लिए download link: `https://billone.upendrakumar-raj.workers.dev/desktop/download`

## Server का पता बदलना (जैसे custom domain)
`%APPDATA%\BillTrix\desktop.json` में यह लिखें:
```
{ "url": "https://app.yourdomain.com" }
```
**ध्यान दें:** domain बदलने पर Print Agent में भी नया पता डालना होगा (`resources/agent.ps1` की लाइन `$Allowed = ...`)। यह ज़रूरत पड़ने पर Claude से करवा लें।

---

## 🏠 Shop Hub (बिना इंटरनेट के कई counters) — v1.0.3 से
**कब काम आता है:** इंटरनेट बार-बार जाता हो, और दुकान में 2 या ज़्यादा counters हों।

**Hub बनाना (एक बार, owner):**
1. दुकान के एक कंप्यूटर पर BillTrix Desktop खोलें → owner से login (इंटरनेट के साथ)
2. नीचे plan वाले डिब्बे में **"🏠 Shop Hub…"** → **Make this computer the Hub**
3. Windows पूछे "Allow access?" → **Allow** (Private network)
4. Hub अपना पता दिखाएगा, जैसे `http://192.168.1.20:18300`

**Counter जोड़ना:**
- **BillTrix Desktop वाले counter:** 🏠 → "Connect to the shop Hub" → पता लिखें (`192.168.1.20`) → **Connect** → एक बार login
- **फ़ोन/दूसरे browser:** उसी Wi-Fi पर `http://192.168.1.20:18300` खोलें

**कैसे चलता है:**
- सारे बिल और stock **Hub पर** — सब counters एक जैसा देखते हैं, **इंटरनेट न हो तब भी**
- इंटरनेट आते ही Hub सब कुछ cloud पर भेजता है (हर 5 सेकंड जाँच), और दूसरी जगह (mobile app, दूसरी branch) के बदलाव ले आता है
- कोई user Hub पर **बिना इंटरनेट** login तभी कर सकता है जब उसने **एक बार इंटरनेट के साथ Hub से login** किया हो
- बिना इंटरनेट: WhatsApp भेजना, Voice (Whisper), नए users/passwords — **इंटरनेट आने पर**
- Hub कंप्यूटर दुकान खुलने के समय **चालू रखें**

**Hub बंद करना:** Hub कंप्यूटर पर 🏠 → **Stop being the shop Hub** (पहले इंटरनेट जोड़ें ताकि सब cloud पहुँच जाए)
