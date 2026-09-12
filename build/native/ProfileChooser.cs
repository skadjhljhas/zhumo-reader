using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class ProfileChooser {
    [STAThread]
    private static int Main() {
        try {
            var data = Environment.GetEnvironmentVariable("ZHUMO_PROFILE_CHOICES") ?? "";
            if (data.Length > 32768) return 3;
            var entries = new JavaScriptSerializer().Deserialize<ArrayList>(Encoding.UTF8.GetString(Convert.FromBase64String(data)));
            if (entries == null || entries.Count < 2 || entries.Count > 8) return 3;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var form = new Form()) {
                form.Text = "朱墨 · 选择阅读资料";
                form.ClientSize = new Size(690, 400);
                form.MinimumSize = new Size(620, 400);
                form.StartPosition = FormStartPosition.CenterScreen;
                form.Font = new Font("Microsoft YaHei UI", 10);
                form.BackColor = Color.FromArgb(245, 248, 249);
                form.MaximizeBox = false;
                form.TopMost = true;
                form.ShowInTaskbar = true;
                var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), RowCount = 4, ColumnCount = 1 };
                layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
                layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
                var intro = new Label { Text = "发现多套朱墨阅读资料。选择这次继续使用的一套。", AutoSize = true, Margin = new Padding(0, 0, 0, 16) };
                var list = new ListBox { Dock = DockStyle.Fill, IntegralHeight = false, BorderStyle = BorderStyle.FixedSingle };
                var path = new TextBox { ReadOnly = true, BorderStyle = BorderStyle.None, Multiline = true, Height = 64, Dock = DockStyle.Fill, BackColor = form.BackColor, Margin = new Padding(0, 12, 0, 6) };
                foreach (Dictionary<string, object> item in entries) {
                    if (!(item["label"] is string) || !(item["path"] is string)) return 3;
                    list.Items.Add((string)item["label"]);
                }
                list.SelectedIndexChanged += delegate {
                    var item = (Dictionary<string, object>)entries[list.SelectedIndex];
                    path.Text = (string)item["path"] + "\r\n文稿位置、阅读设置、字体、模型配置和草稿随整套资料保留。";
                };
                var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.RightToLeft, WrapContents = false };
                var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Size = new Size(90, 34) };
                var confirm = new Button { Text = "继续阅读", DialogResult = DialogResult.OK, Size = new Size(112, 34) };
                buttons.Controls.Add(cancel); buttons.Controls.Add(confirm);
                form.AcceptButton = confirm; form.CancelButton = cancel;
                layout.Controls.Add(intro, 0, 0); layout.Controls.Add(list, 0, 1); layout.Controls.Add(path, 0, 2); layout.Controls.Add(buttons, 0, 3);
                form.Controls.Add(layout); list.SelectedIndex = 0;
                if (form.ShowDialog() != DialogResult.OK) return 2;
                using (var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))) {
                    output.Write(list.SelectedIndex); output.Flush();
                }
                return 0;
            }
        } catch { return 3; }
    }
}
