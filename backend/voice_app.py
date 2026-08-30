"""Production composition root for the additive voice API.

Keeping this outside server.py preserves the existing MobileOps route/model
module byte-for-byte while adding the voice router and its own indexes.
"""

import server

from voice.config import VoiceConfig
from voice.router import create_voice_router


app = server.app
voice_router, voice_repository = create_voice_router(server, VoiceConfig.from_env())
app.include_router(voice_router)


@app.on_event("startup")
async def start_voice_module() -> None:
    await voice_repository.ensure_indexes()
