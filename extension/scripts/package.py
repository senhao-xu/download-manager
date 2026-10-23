from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import json

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text())['version']
output = root / 'artifacts' / f'video-local-downloader-{version}.zip'
output.parent.mkdir(exist_ok=True)
with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
    for source in sorted((root / 'dist').rglob('*')):
        if source.is_file():
            archive.write(source, source.relative_to(root / 'dist'))
print(output)
