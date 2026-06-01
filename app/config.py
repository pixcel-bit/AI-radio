from pathlib import Path

BASE_DIR = Path(__file__).parent.parent  # プロジェクトルート
AUDIO_DIR = BASE_DIR / "audio"
STATIC_DIR = BASE_DIR / "static"
DB_URL = f"sqlite:///{BASE_DIR / 'news_radio.db'}"
