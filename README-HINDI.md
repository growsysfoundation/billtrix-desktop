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

## Updates
- **Features:** अपने-आप, cloud से (Releases पेज से नियंत्रित)। कुछ नहीं करना।
- **Desktop खोल (यह `.exe`)** का update, GitHub Releases से अपने-आप:
  1. `package.json` में `"owner"` में GitHub नाम `growsysfoundation` पहले से लिखा है
  2. `"version"` बढ़ाएँ (जैसे `1.0.1`)
  3. GitHub पर एक **tag** बनाएँ: Releases → **Draft a new release** → Tag `v1.0.1` → Publish
  4. Actions अपने-आप नया installer बनाकर Release में रखेगा, और दुकानों के app 6 घंटे के भीतर उसे download करके पूछेंगे "**Restart now / Later**"

---

## Server का पता बदलना (जैसे custom domain)
`%APPDATA%\BillTrix\desktop.json` में यह लिखें:
```
{ "url": "https://app.yourdomain.com" }
```
**ध्यान दें:** domain बदलने पर Print Agent में भी नया पता डालना होगा (`resources/agent.ps1` की लाइन `$Allowed = ...`)। यह ज़रूरत पड़ने पर Claude से करवा लें।
