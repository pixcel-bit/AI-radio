import os
import asyncio
from pathlib import Path

from .config import AUDIO_DIR

TTS_PROVIDER = os.environ.get("TTS_PROVIDER", "gtts").lower()


async def synthesize(script: str, date_str: str) -> str:
    """スクリプトを音声合成してMP3の絶対パスを返す"""
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    output_path = AUDIO_DIR / f"{date_str}.mp3"

    if TTS_PROVIDER == "openai":
        await _synthesize_openai(script, output_path)
    else:
        await _synthesize_gtts(script, output_path)

    return str(output_path)


async def _synthesize_openai(script: str, output_path: Path):
    from openai import AsyncOpenAI
    openai_client = AsyncOpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))

    chunks = _split_text(script, max_chars=4000)
    audio_segments: list[bytes] = []

    for chunk in chunks:
        response = await openai_client.audio.speech.create(
            model="tts-1",
            voice="nova",
            input=chunk,
            response_format="mp3",
        )
        audio_segments.append(response.content)

    with open(output_path, "wb") as f:
        for segment in audio_segments:
            f.write(segment)


async def _synthesize_gtts(script: str, output_path: Path):
    from gtts import gTTS

    def _run():
        tts = gTTS(text=script, lang="ja", slow=False)
        tts.save(str(output_path))

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _run)


def _split_text(text: str, max_chars: int) -> list[str]:
    sentences = text.replace("。", "。\n").split("\n")
    chunks, current = [], ""
    for sentence in sentences:
        if len(current) + len(sentence) > max_chars:
            if current:
                chunks.append(current.strip())
            current = sentence
        else:
            current += sentence
    if current:
        chunks.append(current.strip())
    return chunks or [text]
