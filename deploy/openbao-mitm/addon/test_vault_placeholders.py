import base64
import unittest

from vault_placeholders import (
    PlaceholderError,
    has_placeholder,
    placeholder_names,
    substitute,
    substitute_header,
)

ALLOWLIST = {
    "DEEPSEEK_API_KEY": ["api.deepseek.com"],
    "DEEPSEEK_WEB_API_KEY": ["api.deepseek.com"],
    "TELEGRAM_BOT_TOKEN": ["api.telegram.org"],
    "LANGFUSE_PUBLIC_KEY": ["cloud.langfuse.com"],
    "LANGFUSE_SECRET_KEY": ["cloud.langfuse.com"],
}


def resolve(name: str) -> str:
    if name not in ALLOWLIST:
        raise KeyError(name)
    return f"resolved-openbao-{name.lower()}"


class SubstituteTests(unittest.TestCase):
    def test_replaces_placeholder_for_allowlisted_host(self):
        out = substitute("Bearer __vault_DEEPSEEK_API_KEY__", "api.deepseek.com", ALLOWLIST, resolve)
        self.assertEqual(out, "Bearer resolved-openbao-deepseek_api_key")

    def test_replaces_web_and_telegram_placeholders_for_allowlisted_hosts(self):
        web = substitute("Bearer __vault_DEEPSEEK_WEB_API_KEY__", "api.deepseek.com", ALLOWLIST, resolve)
        self.assertEqual(web, "Bearer resolved-openbao-deepseek_web_api_key")
        tg = substitute("/bot__vault_TELEGRAM_BOT_TOKEN__/getMe", "api.telegram.org", ALLOWLIST, resolve)
        self.assertEqual(tg, "/botresolved-openbao-telegram_bot_token/getMe")

    def test_host_match_is_case_insensitive_and_exact(self):
        out = substitute("__vault_DEEPSEEK_API_KEY__", "API.DeepSeek.com", ALLOWLIST, resolve)
        self.assertEqual(out, "resolved-openbao-deepseek_api_key")
        for look_alike in ("api.deepseek.com.evil.example", "evil-api.deepseek.com", "deepseek.com"):
            with self.subTest(host=look_alike), self.assertRaises(PlaceholderError):
                substitute("__vault_DEEPSEEK_API_KEY__", look_alike, ALLOWLIST, resolve)

    def test_disallowed_host_is_refused_without_leaking_the_value(self):
        with self.assertRaises(PlaceholderError) as raised:
            substitute("/bot__vault_TELEGRAM_BOT_TOKEN__/getMe", "attacker.example", ALLOWLIST, resolve)
        self.assertIn("TELEGRAM_BOT_TOKEN", str(raised.exception))
        self.assertNotIn("resolved-openbao", str(raised.exception))

    def test_unknown_name_is_refused(self):
        with self.assertRaises(PlaceholderError):
            substitute("__vault_OPENAI_API_KEY__", "api.deepseek.com", ALLOWLIST, resolve)

    def test_resolver_failure_is_reported_by_name_only(self):
        def failing(name: str) -> str:
            raise OSError("connection refused to https://aster-openbao:8200")

        with self.assertRaises(PlaceholderError) as raised:
            substitute("__vault_DEEPSEEK_API_KEY__", "api.deepseek.com", ALLOWLIST, failing)
        self.assertEqual(str(raised.exception), "placeholder DEEPSEEK_API_KEY could not be resolved")

    def test_text_without_placeholders_is_unchanged(self):
        text = "Authorization: Bearer plain-text-without-placeholder"
        self.assertEqual(substitute(text, "api.deepseek.com", ALLOWLIST, resolve), text)

    def test_several_placeholders_in_one_value(self):
        text = "__vault_DEEPSEEK_API_KEY__;__vault_DEEPSEEK_WEB_API_KEY__"
        out = substitute(text, "api.deepseek.com", ALLOWLIST, resolve)
        self.assertEqual(out, "resolved-openbao-deepseek_api_key;resolved-openbao-deepseek_web_api_key")

    def test_one_disallowed_placeholder_fails_the_whole_value(self):
        text = "__vault_DEEPSEEK_API_KEY__ __vault_TELEGRAM_BOT_TOKEN__"
        with self.assertRaises(PlaceholderError):
            substitute(text, "api.deepseek.com", ALLOWLIST, resolve)

    def test_placeholder_names_lists_every_name(self):
        self.assertEqual(
            placeholder_names("__vault_DEEPSEEK_API_KEY__ x __vault_TELEGRAM_BOT_TOKEN__"),
            ["DEEPSEEK_API_KEY", "TELEGRAM_BOT_TOKEN"],
        )


def basic(credentials: str) -> str:
    return "Basic " + base64.b64encode(credentials.encode("utf-8")).decode("ascii")


def decode_basic(value: str) -> str:
    scheme, _, encoded = value.partition(" ")
    assert scheme == "Basic"
    return base64.b64decode(encoded, validate=True).decode("utf-8")


class SubstituteHeaderTests(unittest.TestCase):
    def test_substitutes_placeholders_inside_basic_credentials(self):
        header = basic("__vault_LANGFUSE_PUBLIC_KEY__:__vault_LANGFUSE_SECRET_KEY__")
        out = substitute_header(header, "cloud.langfuse.com", ALLOWLIST, resolve)
        self.assertEqual(
            decode_basic(out),
            "resolved-openbao-langfuse_public_key:resolved-openbao-langfuse_secret_key",
        )

    def test_public_key_can_stay_plaintext_next_to_a_vaulted_secret(self):
        header = basic("pk-lf-visible:__vault_LANGFUSE_SECRET_KEY__")
        out = substitute_header(header, "cloud.langfuse.com", ALLOWLIST, resolve)
        self.assertEqual(decode_basic(out), "pk-lf-visible:resolved-openbao-langfuse_secret_key")

    def test_encoded_placeholder_for_another_host_is_refused(self):
        header = basic("__vault_LANGFUSE_PUBLIC_KEY__:__vault_LANGFUSE_SECRET_KEY__")
        with self.assertRaises(PlaceholderError) as raised:
            substitute_header(header, "attacker.example", ALLOWLIST, resolve)
        self.assertIn("LANGFUSE_PUBLIC_KEY", str(raised.exception))
        self.assertNotIn("resolved-openbao", str(raised.exception))

    def test_plain_basic_credentials_are_unchanged(self):
        header = basic("user:ordinary-password")
        self.assertEqual(substitute_header(header, "cloud.langfuse.com", ALLOWLIST, resolve), header)

    def test_malformed_basic_value_is_unchanged(self):
        header = "Basic not-base64!"
        self.assertEqual(substitute_header(header, "cloud.langfuse.com", ALLOWLIST, resolve), header)

    def test_raw_header_placeholders_still_use_the_plain_path(self):
        out = substitute_header("Bearer __vault_DEEPSEEK_API_KEY__", "api.deepseek.com", ALLOWLIST, resolve)
        self.assertEqual(out, "Bearer resolved-openbao-deepseek_api_key")

    def test_has_placeholder_sees_raw_and_encoded_forms(self):
        self.assertTrue(has_placeholder("__vault_DEEPSEEK_API_KEY__"))
        self.assertTrue(has_placeholder(basic("x:__vault_LANGFUSE_SECRET_KEY__")))
        self.assertFalse(has_placeholder(basic("user:ordinary-password")))
        self.assertFalse(has_placeholder("Bearer plain"))


if __name__ == "__main__":
    unittest.main()
