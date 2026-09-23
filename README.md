# QR Code Linker

A small static web app that combines several links into **one QR code**.

Add your links, and the app creates a QR code. When someone scans it, they get a simple page that lists every link as a button.

## How it works

- A QR code can only hold one piece of data, so the app puts all your links into the URL of its own page (`index.html#d=...`, Base64-encoded JSON).
- When that URL is opened, the app sees the data in the URL hash and shows the list of links instead of the editor.
- There is no server, database or account. The links live only in the QR code and its URL.
- There is also a **plain text** option that puts the links straight into the QR code as text. It needs no hosting, but some phone scanners won't make the links tappable.

Features: page title, up to 20 links with optional labels, live preview, PNG/SVG download, copy link, and support for `http(s)`, `mailto:`, `tel:` and `sms:` links. It also has a dark mode and works on mobile.

## Run locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` straight from disk also works for building codes. But a QR code made from a `file://` page points to your own computer, so phones can't open it. Host the app to share codes.

## Deploy (GitHub Pages)

1. Push this repository to GitHub.
2. Go to **Settings → Pages**, choose **Deploy from a branch**, and select the branch and `/ (root)`.
3. Open the Pages URL and make your QR codes there. Each code will point to that hosted page.

## Limits

The data is stored in the QR code itself, so more links and longer URLs make the code denser. The app shows an error when the data won't fit (about 2 KB). Keep the number of links small so the code scans easily.

## Credits

QR encoding by [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT, vendored in `vendor/qrcode.js`).
