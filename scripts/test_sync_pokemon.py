"""Offline regressions for the actual upstream links and local tuple schema."""
import io
from contextlib import redirect_stdout
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import sync_pokemon as target


class PokemonDetectionTests(unittest.TestCase):
    def local(self, text):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'fetch_set_cards.py'
            path.write_text(text, encoding='utf-8')
            return target.get_local_sets(path)

    def test_multiline_query_nested_name_and_single_quoted_links(self):
        html = '''<a
          href='/sets/11823/30th-celebration?setCardCountMode=anyCardVariant'
          class="set-logo-grid-item-name"><span>30th</span> Celebration</a>'''
        self.assertEqual(target.parse_remote_sets(html), [('11823', '/sets/11823/30th-celebration', '30th Celebration')])

    def test_image_title_and_repeated_links_are_deduplicated(self):
        html = '''<a href="/sets/1/first?mode=a" title="First"><img></a>
                  <a href="https://www.tcgcollector.com/sets/1/first?mode=b">First</a>
                  <a href="https://other.invalid/sets/2/foreign">Foreign</a>'''
        self.assertEqual(len(target.parse_remote_sets(html)), 1)

    def test_empty_or_blocked_page_fails(self):
        for html in ('', '<html><title>Just a moment</title></html>'):
            with self.subTest(html=html), self.assertRaisesRegex(ValueError, 'zero readable sets'):
                target.parse_remote_sets(html)

    def test_actual_three_column_schema_is_read_without_executing_script(self):
        result = self.local('raise RuntimeError("must not execute")\n'
            'POKEMON_SETS = [("M6a", "일판 이름", "https://www.tcgcollector.com/sets/11823/30th-celebration")]')
        self.assertEqual(result, [('M6a', 'https://www.tcgcollector.com/sets/11823/30th-celebration')])

    def test_legacy_two_column_schema_remains_supported(self):
        self.assertEqual(len(self.local("POKEMON_SETS = [('MF', 'https://www.tcgcollector.com/sets/11822/premium')]")), 1)

    def test_empty_missing_or_executable_definition_fails(self):
        for text in ('POKEMON_SETS=[]', 'OTHER=[]', 'POKEMON_SETS=get_sets()'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                self.local(text)

    def test_duplicate_local_ids_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.local("POKEMON_SETS=[('A','https://www.tcgcollector.com/sets/1/a'),('B','https://www.tcgcollector.com/sets/1/b')]" )

    def test_slug_rename_is_not_a_new_catalogue_identity(self):
        self.assertEqual(target.find_new_sets([('1', '/sets/1/new-slug', 'Name')],
            [('A', 'https://www.tcgcollector.com/sets/1/old-slug')]), [])

    def test_genuine_new_id_is_reported_as_candidate(self):
        result = target.find_new_sets([('2', '/sets/2/new-set?mode=any', 'New set')],
            [('A', 'https://www.tcgcollector.com/sets/1/old')])
        self.assertEqual(result, [('2', 'https://www.tcgcollector.com/sets/2/new-set', 'New set', 'new-set')])

    def test_zero_lists_never_mean_no_new_sets(self):
        for remote, local in [([], []), ([], [('A', 'https://www.tcgcollector.com/sets/1/a')])]:
            with self.assertRaisesRegex(ValueError, 'nonempty'):
                target.find_new_sets(remote, local)

    def test_source_failure_returns_failed_exit(self):
        with patch.object(target, 'discover_remote_sets', side_effect=ValueError('blocked')), redirect_stdout(io.StringIO()) as log:
            self.assertEqual(target.main([]), 1)
        self.assertNotIn('✅ 신규 세트 없음', log.getvalue())


if __name__ == '__main__':
    unittest.main()
