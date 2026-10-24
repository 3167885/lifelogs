package com.lifelogs.sleep;

import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 个人自用 MVP：登录 token 的加密持久化。
 * AES-256-GCM，密钥在 Android Keystore 中且不可导出；密文+IV 存应用私有
 * SharedPreferences。JS 侧仅在内存持有 token 用于请求头。
 * 不写 localStorage，不写业务 SQLite 表。
 */
@CapacitorPlugin(name = "SecureToken")
public class SecureTokenPlugin extends Plugin {

    private static final String KEY_ALIAS = "sleepapp.token.aes";
    private static final String PREFS = "secure_token";
    private static final String FIELD_IV = "iv";
    private static final String FIELD_CT = "ct";

    @PluginMethod
    public void setToken(PluginCall call) {
        String token = call.getString("token");
        if (token == null) {
            call.reject("token required");
            return;
        }
        try {
            // 不指定 provider：由系统按密钥所属的 Keystore 选择实现
            // （显式传 "AndroidKeyStore" 在部分镜像上会报 provider 不支持该变换）。
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            // 随机化加密要求 IV 由实现生成，调用方自带 IV 会被拒绝。
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(token.getBytes("UTF-8"));
            SharedPreferences.Editor ed = getContext()
                .getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE).edit();
            ed.putString(FIELD_IV, Base64.encodeToString(iv, Base64.NO_WRAP));
            ed.putString(FIELD_CT, Base64.encodeToString(ct, Base64.NO_WRAP));
            ed.apply();
            call.resolve();
        } catch (Exception e) {
            // Keystore 密钥失效（如系统备份恢复）→ 清掉密文，按未登录处理。
            clearPrefs();
            call.reject("store failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getToken(PluginCall call) {
        SharedPreferences sp = getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
        String ivB64 = sp.getString(FIELD_IV, null);
        String ctB64 = sp.getString(FIELD_CT, null);
        JSObject ret = new JSObject();
        if (ivB64 == null || ctB64 == null) {
            call.resolve(ret);
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(),
                new GCMParameterSpec(128, Base64.decode(ivB64, Base64.NO_WRAP)));
            String token = new String(cipher.doFinal(Base64.decode(ctB64, Base64.NO_WRAP)), "UTF-8");
            ret.put("token", token);
            call.resolve(ret);
        } catch (Exception e) {
            // 无法解密（密钥丢失）：清除并要求重新登录，不泄露任何内容。
            clearPrefs();
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void clearToken(PluginCall call) {
        clearPrefs();
        call.resolve();
    }

    private void clearPrefs() {
        getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
            .edit().clear().apply();
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build());
        return gen.generateKey();
    }
}
