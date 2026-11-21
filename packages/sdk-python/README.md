# enlitt (Python SDK)

Server-side Enlitt SDK for Python (asyncio). Behavior is specified in `specs/SDK-side routing.md`
("Python SDK") and `specs/Account.md`.

## Images, speech, and transcription

Premium media calls run on your own `AsyncOpenAI` client, one premium operation each. There is
no standard media model and there are no price helpers: pass a constant `price`, or a function
of the call's `OpenAIPremiumMediaPriceContext`.

```python
import math

from openai import AsyncOpenAI
from enlitt.openai import EnlittMediaCallOptions, enlitt

client = enlitt(AsyncOpenAI())

image = await client.images.generate(
    model="gpt-image-1",
    prompt="A watercolor fox",
    enlitt=EnlittMediaCallOptions(max_charge="100000000", price="40000000"),  # $0.04
)


def per_second(call):
    # Your own pricing: $0.0001 per started second the provider reports, else $0.001.
    seconds = getattr(getattr(call.response, "usage", None), "seconds", None)
    return str(100_000 * math.ceil(seconds)) if seconds else "1000000"


text = await client.audio.transcriptions.create(
    model="gpt-4o-mini-transcribe",
    file=open("clip.mp3", "rb"),
    enlitt=EnlittMediaCallOptions(max_charge="10000000", price=per_second),
)
```
