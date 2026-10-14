"""Regenerate synthetic OCR fixtures (Pillow, reportlab and pypdf required).

Usage: python create_ocr_fixtures.py C:/Windows/Fonts/msyh.ttc
All text is synthetic. Pages 2/3 contain only raster images; page 4 is blank.
"""
from io import BytesIO
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader, PdfWriter
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas

root = Path(__file__).resolve().parent
font = ImageFont.truetype(sys.argv[1], 60)
document = Canvas(str(root / "ocr-mixed.pdf"), pagesize=(595, 842), invariant=1)
document.setFont("Helvetica", 18)
document.drawString(60, 730, "Native text remains unchanged.")
document.drawString(60, 690, "Project sample release: 2026.")
document.showPage()
for lines in [
    ["设备巡检规范", "每月十五日检查冷却系统。", "异常设备应立即停止使用。"],
    ["SCAN SAFETY GUIDE", "Emergency code: OCR-2468.", "Inspect the cooling system", "every month."],
]:
    image = Image.new("RGB", (1654, 2339), "white")
    draw = ImageDraw.Draw(image)
    for index, line in enumerate(lines):
        draw.text((150, 220 + index * 150), line, font=font, fill="black")
    data = BytesIO()
    image.save(data, format="PNG")
    document.drawImage(ImageReader(data), 0, 0, width=595, height=842)
    document.showPage()
document.showPage()
document.save()
reader = PdfReader(root / "ocr-mixed.pdf")
writer = PdfWriter()
writer.add_page(reader.pages[1])
writer.add_page(reader.pages[2])
with (root / "ocr-scanned.pdf").open("wb") as output:
    writer.write(output)
print("Created four-page mixed and two-page scanned PDFs.")
