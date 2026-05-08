package kr.tcghub.app;

import android.view.KeyEvent;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /**
     * 폰 하단 뒤로가기 버튼 처리:
     * - WebView 에 history 가 있으면 → 사이트 이전 페이지로 (history.back)
     * - 없으면 (홈 또는 첫 페이지) → 기본 동작 (앱 종료 다이얼로그 또는 종료)
     */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && this.bridge != null) {
            WebView wv = this.bridge.getWebView();
            if (wv != null && wv.canGoBack()) {
                wv.goBack();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }
}
