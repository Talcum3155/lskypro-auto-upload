import { App, PluginSettingTab, Setting } from "obsidian";
import imageAutoUploadPlugin from "./main";
import { t } from "./lang/helpers";

export interface PluginSettings {
  uploadByClipSwitch: boolean;
  uploadServer: string;
  token: string;
  strategy_id: string;
  imageSizeSuffix: string;
  uploader: string;
  workOnNetWork: boolean;
  newWorkBlackDomains: string;
  fixPath: boolean;
  applyImage: boolean;
  deleteSource: boolean;
  compressImages: boolean;
  compressionQuality: number;
  compressionMaxDimension: number;
  compressionMinKB: number;
  [propName: string]: any;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  uploadByClipSwitch: true,
  uploader: "LskyPro",
  token: "",
  strategy_id:"",
  uploadServer: "https://lsky.xxxx",
  imageSizeSuffix: "",
  workOnNetWork: false,
  fixPath: false,
  applyImage: true,
  newWorkBlackDomains: "",
  deleteSource: false,
  compressImages: true,
  compressionQuality: 0.85,
  compressionMaxDimension: 0,
  compressionMinKB: 256,
};

export class SettingTab extends PluginSettingTab {
  plugin: imageAutoUploadPlugin;

  constructor(app: App, plugin: imageAutoUploadPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    let { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: t("Plugin Settings") });
    new Setting(containerEl)
      .setName(t("Auto pasted upload"))
      .setDesc(
        "启用该选项后，黏贴图片时会自动上传到lsky图床"
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.uploadByClipSwitch)
          .onChange(async value => {
            this.plugin.settings.uploadByClipSwitch = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("Default uploader"))
      .setDesc(t("Default uploader"))
      .addDropdown(cb =>
        cb
          .addOption("LskyPro", "LskyPro")
          .setValue(this.plugin.settings.uploader)
          .onChange(async value => {
            this.plugin.settings.uploader = value;
            this.display();
            await this.plugin.saveSettings();
          })
      );

    if (this.plugin.settings.uploader === "LskyPro") {
      new Setting(containerEl)
        .setName("LskyPro 域名")
        .setDesc("LskyPro 域名（不需要填写完整的API路径）")
        .addText(text =>
          text
            .setPlaceholder("请输入LskyPro 域名")
            .setValue(this.plugin.settings.uploadServer)
            .onChange(async key => {
              this.plugin.settings.uploadServer = key;
              await this.plugin.saveSettings();
            })
        );
        new Setting(containerEl)
        .setName("LskyPro Token")
        .setDesc("LskyPro Token")
        .addText(text =>
          text
            .setPlaceholder("请输入LskyPro Token")
            .setValue(this.plugin.settings.token)
            .onChange(async key => {
              this.plugin.settings.token = key;
              await this.plugin.saveSettings();
            })
        );
        new Setting(containerEl)
        .setName("LskyPro Strategy id")
        .setDesc("LskyPro 存储策略ID（非必填）")
        .addText(text =>
          text
            .setPlaceholder("请输入LskyPro 存储策略ID（非必填）")
            .setValue(this.plugin.settings.strategy_id)
            .onChange(async key => {
              this.plugin.settings.strategy_id = key;
              await this.plugin.saveSettings();
            })
        );
    }


    new Setting(containerEl)
      .setName("上传前压缩图片")
      .setDesc("将较大的静态 PNG、JPEG、BMP 转为 WebP，保留透明背景。仅在文件变小时使用压缩结果；不修改本地原图。图床需支持 WebP。")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.compressImages)
        .onChange(async value => {
          this.plugin.settings.compressImages = value;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("压缩质量")
      .setDesc("默认 85%。数值越高越清晰，体积也越大。文字截图建议 85%–95%。")
      .addSlider(slider => slider.setLimits(10, 100, 5)
        .setValue(Math.round(this.plugin.settings.compressionQuality * 100))
        .setDynamicTooltip().onChange(async value => {
          this.plugin.settings.compressionQuality = value / 100;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("图片最长边（像素）")
      .setDesc("0 表示保留原始分辨率（默认）。例如 2560：超出时等比例缩小，不裁剪、不放大。长截图建议保留原始分辨率。")
      .addText(text => text.setValue(String(this.plugin.settings.compressionMaxDimension))
        .onChange(async value => {
          if (!/^\d+$/.test(value.trim())) return;
          const size = Number(value);
          if (!Number.isSafeInteger(size) || (size !== 0 && size < 256)) return;
          this.plugin.settings.compressionMaxDimension = size;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("压缩起始大小（KB）")
      .setDesc("默认 256 KB，小于此大小的图片直接上传。0 表示所有支持的图片都尝试压缩。")
      .addText(text => text.setValue(String(this.plugin.settings.compressionMinKB))
        .onChange(async value => {
          if (!/^\d+$/.test(value.trim())) return;
          const size = Number(value);
          if (!Number.isSafeInteger(size)) return;
          this.plugin.settings.compressionMinKB = size;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("Image size suffix"))
      .setDesc(t("Image size suffix Description"))
      .addText(text =>
        text
          .setPlaceholder(t("Please input image size suffix"))
          .setValue(this.plugin.settings.imageSizeSuffix)
          .onChange(async key => {
            this.plugin.settings.imageSizeSuffix = key;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("Work on network"))
      .setDesc(t("Work on network Description"))
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.workOnNetWork)
          .onChange(async value => {
            this.plugin.settings.workOnNetWork = value;
            this.display();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("Network Domain Black List"))
      .setDesc(t("Network Domain Black List Description"))
      .addTextArea(textArea =>
        textArea
          .setValue(this.plugin.settings.newWorkBlackDomains)
          .onChange(async value => {
            this.plugin.settings.newWorkBlackDomains = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("Upload when clipboard has image and text together"))
      .setDesc(
        t(
          "When you copy, some application like Excel will image and text to clipboard, you can upload or not."
        )
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.applyImage)
          .onChange(async value => {
            this.plugin.settings.applyImage = value;
            this.display();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("Delete source file after you upload file"))
      .setDesc(t("Delete source file in ob assets after you upload file."))
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.deleteSource)
          .onChange(async value => {
            this.plugin.settings.deleteSource = value;
            this.display();
            await this.plugin.saveSettings();
          })
      );
  }
}
