import {spawnSync} from 'node:child_process';

// Keep the actual loader, page, identity, owner and recovery contracts together.
// Production-data compilation and the public asset budget remain deployment gates.
const tests = [
 'test_app_route_loader.cjs','test_app_route_integration.cjs',
 'test_home_startup.cjs','test_home_summary_integration.cjs','test_market_chart_startup.cjs',
 'test_mobile_home.mjs','test_home_discovery.mjs','test_home_news_media.mjs',
 'test_portfolio_screen.cjs','test_portfolio_summary.cjs','test_portfolio_summary_client.cjs',
 'test_search_fastpath.cjs','test_card_search_engine.cjs','test_fast_price_search.cjs',
 'test_search_shard_cache.cjs','test_search_modal_catalog_rows.cjs','test_search_snapshot.cjs',
 'test_japanese_set_metadata.cjs','test_catalogue_card_navigation.cjs',
 'test_card_info_pricing_integration.cjs','test_cardinfo_list_budget.cjs','test_cardinfo_screen.mjs',
 'test_english_catalog_lazy.cjs','test_english_search_demand.cjs',
 'test_english_catalog.cjs','test_english_set_images.cjs','test_chinese_catalog.cjs',
 'test_public_board_loading.cjs','test_scoped_dom_observers.mjs','test_card_favorites.cjs',
 'test_initial_thumbnail_rendering.mjs','test_card_thumbnails.cjs','test_card_artwork.mjs',
 'test_pretendard_subsets.mjs','test_public_cache_limits.cjs',
];
const result = spawnSync(process.execPath, ['--test', ...tests.map(name=>'scripts/'+name)],
 {cwd:new URL('../', import.meta.url), stdio:'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
