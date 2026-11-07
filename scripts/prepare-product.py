"""Inspect an original product and package agent-reviewed listing metadata. Never calls Etsy."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import zipfile

from PIL import Image
from pypdf import PdfReader


def inspect_package(source):
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 40 or sum(e.file_size for e in entries) > 45_000_000:
            raise ValueError("Product ZIP exceeds the supported bounded package limits.")
        assets = []
        for entry in entries:
            path = PurePosixPath(entry.filename)
            if path.is_absolute() or '..' in path.parts or '\\' in entry.filename:
                raise ValueError("Unsafe ZIP filename.")
            if entry.is_dir() or path.suffix.lower() not in ('.pdf', '.png', '.jpg', '.jpeg'):
                continue
            if entry.file_size > (20_000_000 if path.suffix.lower() == '.pdf' else 10_000_000):
                raise ValueError("Product file exceeds Etsy or Studio size limits.")
            assets.append((entry.filename, archive.read(entry)))
    pdfs = [(name, data) for name, data in assets if name.lower().endswith('.pdf')]
    images = [(name, data) for name, data in assets if not name.lower().endswith('.pdf')]
    if len(pdfs) != 1 or not 1 <= len(images) <= 10:
        raise ValueError("Include one PDF and 1–10 JPG/PNG preview images.")
    pdf_name, pdf_bytes = pdfs[0]
    reader = PdfReader(io.BytesIO(pdf_bytes), strict=True)
    if reader.is_encrypted:
        raise ValueError("The buyer PDF must not be password protected.")
    if not reader.pages:
        raise ValueError("The buyer PDF has no pages.")
    facts = {"pdfName": pdf_name, "pdfSha256": hashlib.sha256(pdf_bytes).hexdigest(),
             "pdfBytes": len(pdf_bytes), "pageCount": len(reader.pages),
             "pageSizesPoints": sorted({(round(float(page.mediabox.width), 2), round(float(page.mediabox.height), 2)) for page in reader.pages}),
             "textSample": '\n'.join((page.extract_text() or '') for page in reader.pages[:12])[:16000], "images": []}
    for name, data in images:
        with Image.open(io.BytesIO(data)) as image:
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            if min(image.size) < 2000:
                raise ValueError(name + ": prepare a preview at least 2000 pixels on each side. Render the original PDF at full resolution; do not invent new contents.")
            if 'A' in image.getbands() and image.getchannel('A').getextrema() != (255, 255):
                raise ValueError(name + ": Etsy previews must not contain transparency. Use an opaque original export or a rendered PDF page.")
            if image.mode not in ('RGB', 'L', 'RGBA'):
                raise ValueError(name + ": use an RGB or grayscale preview export.")
            facts['images'].append({"name": name, "width": image.width, "height": image.height, "bytes": len(data)})
    return assets, facts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--report', required=True)
    parser.add_argument('--listing')
    parser.add_argument('--output')
    args = parser.parse_args()
    assets, facts = inspect_package(args.input)
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(facts, ensure_ascii=False, indent=2), encoding='utf-8')
    if args.listing or args.output:
        if not args.listing or not args.output:
            parser.error('--listing and --output must be used together')
        metadata = json.loads(Path(args.listing).read_text(encoding='utf-8'))
        if metadata.get('reviewed') is not True:
            raise ValueError("The agent must review the actual PDF renders, images and listing before packaging.")
        metadata.update(schemaVersion=1, facts={key: value for key, value in facts.items() if key != 'textSample'})
        metadata.setdefault('price', '9.99')
        metadata.setdefault('currency', 'USD')
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in assets:
                archive.writestr(name, data)
            archive.writestr('listing.json', json.dumps(metadata, ensure_ascii=False))
        if output.stat().st_size > 20_000_000:
            output.unlink()
            raise ValueError("Prepared ZIP exceeds Studio's 20 MB upload limit.")
        print('Prepared product package created; original PDF bytes preserved. No Etsy requests were made.')
    else:
        print('Actual PDF and images inspected. Review the report and render the PDF before writing listing details.')


if __name__ == '__main__':
    main()
