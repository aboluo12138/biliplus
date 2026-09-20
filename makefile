ZIP_FILE := biliplus.zip
PACKAGE_PATHS := css scripts settings manifest.json logo.png
FIREFOX_OUT := dist

.PHONY: zip test firefox firefox-unpacked

test:
	node --test tests/*.test.js tests/*.test.cjs

zip:
	rm -f $(ZIP_FILE)
	zip -r $(ZIP_FILE) $(PACKAGE_PATHS) -x '*/.DS_Store'

# 火狐扩展包：校验 manifest.firefox.json 并生成 dist/firefox 与 zip/xpi
firefox:
	node tools/build-firefox.cjs --out $(FIREFOX_OUT)

# 只生成可直接临时加载的目录，不生成压缩包
firefox-unpacked:
	node tools/build-firefox.cjs --out $(FIREFOX_OUT) --unpacked-only
