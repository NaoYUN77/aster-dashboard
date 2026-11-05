import base64
import os
import tempfile
import unittest

from proxy_token import ProxyTokenError, ProxyTokenGate, load_token

# Fixed, obviously synthetic value; not a credential.
TOKEN = "test-proxy-token-" + "x" * 32


def basic(username: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{username}:{password}".encode()).decode()


class ProxyTokenTests(unittest.TestCase):
    def test_accepts_only_the_configured_basic_credentials(self):
        gate = ProxyTokenGate(TOKEN)
        self.assertTrue(gate.allows(basic("aster", TOKEN)))
        self.assertTrue(gate.allows("basic " + basic("aster", TOKEN)[6:]))
        for header in (
            None,
            "",
            basic("aster", "wrong-but-long-enough-token"),
            basic("other", TOKEN),
            basic("aster", ""),
            "Bearer " + TOKEN,
            "Basic",
            "Basic !!!not-base64!!!",
            "Basic " + base64.b64encode(TOKEN.encode()).decode(),  # no colon
            "Basic " + base64.b64encode(b"aster:wrong").decode() + "\n",
        ):
            with self.subTest(header=header):
                self.assertFalse(gate.allows(header))

    def test_non_ascii_credentials_are_refused_not_raised(self):
        header = "Basic " + base64.b64encode("aster:é".encode()).decode()
        self.assertFalse(ProxyTokenGate(TOKEN).allows(header))

    def test_token_file_is_read_stripped_and_validated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "token")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(TOKEN + "\n")
            self.assertEqual(load_token(path), TOKEN)
            self.assertTrue(ProxyTokenGate.from_file(path).allows(basic("aster", TOKEN)))

            for bad in ("short", TOKEN + " extra", TOKEN + "\nsecond-line"):
                with self.subTest(bad=bad):
                    with open(path, "w", encoding="utf-8") as handle:
                        handle.write(bad)
                    with self.assertRaises(ProxyTokenError):
                        load_token(path)

    def test_missing_file_and_malformed_tokens_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ProxyTokenError):
                load_token(os.path.join(directory, "absent"))
        for bad in ("", "short", "not hex " + "a" * 64, "a" * 257):
            with self.subTest(bad=bad), self.assertRaises(ProxyTokenError):
                ProxyTokenGate(bad)


if __name__ == "__main__":
    unittest.main()
