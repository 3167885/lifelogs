package com.lifelogs.sleep;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureTokenPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        // 回到前台：通知 WebView 触发一次同步（桥接自带事件派发，不新增插件）。
        if (getBridge() != null) {
            getBridge().triggerWindowJSEvent("appResume");
        }
    }
}
