"""Inference gateway — single router for image / video / voice / text / etc.

Strategic posture: build-our-own-first, fall back through tiers. The
router prefers `ontold-default` deployments; when those don't exist yet
(early days) it falls through `ontold-local-gpu` → `partner-runware` →
`third-party-api`. As we ship owned models, flipping their status from
'planned' to 'healthy' makes them automatically preferred — no
app-side changes.

Pattern mirrors api/director/{formats,voice_presets}.py: catalogue data
lives in registry.py (Python mirror of data/models.ts), routing logic
in router.py, per-provider clients in providers/.
"""

__version__ = "0.1.0"
