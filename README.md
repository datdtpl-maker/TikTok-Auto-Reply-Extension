# TikTok Auto-Reply Gemini AI — Chrome Extension

Tiện ích mở rộng Google Chrome (Manifest V3) giúp tự động quét, phân tích ngữ cảnh và trả lời **Tin nhắn** và **Bình luận** trên **TikTok Business Suite** cũng như **Hoạt động TikTok** bằng **Google Gemini API** (mặc định `gemini-3.8-flash`), chạy trực tiếp trên trình duyệt mà không cần cài đặt server trung gian.

---

## Tính năng chi tiết

### 1. Tự động quét & trả lời Tin nhắn (`tiktok.com/business-suite/messages`)
- **Tương thích kiến trúc cross-iframe của TikTok Business Suite:** Truy cập trực tiếp `iframe[src*="/messages"]` (`[data-e2e="dm-new-conversation-list"]` và `[data-e2e="dm-new-chatbox"]`).
- **Quét các cuộc hội thoại gần nhất:** Mặc định kiểm tra **10 cuộc hội thoại gần nhất** (tùy chỉnh được từ 1–20 trong Popup), chờ xác nhận khung chat đổi đúng tên khách hàng rồi mới đọc nội dung để tránh nhầm hội thoại.
- **Tự động xử lý Yêu cầu tin nhắn (`Message requests` / `Yêu cầu tin nhắn`):** Khi tài khoản cá nhân nhắn tin bị đẩy vào mục `Message requests` / `Yêu cầu tin nhắn`, extension tự mở vào mục này, quét theo số lượng hội thoại cài đặt trong Popup, tự bấm **Accept / Chấp nhận** (nếu TikTok yêu cầu), trả lời khách và quay lại danh sách Tin nhắn chính.
- **Phân biệt tin khách và tin của kênh:** Tự xác định vị trí bong bóng tin nhắn (bên trái là khách, bên phải là kênh). Chỉ khi **tin nhắn cuối cùng là của khách** (kênh chưa phản hồi) thì AI mới soạn và gửi trả lời.
- **Bám sát ngữ cảnh đầy đủ:** Gom toàn bộ tin nhắn liên tiếp cuối cùng của khách, kèm **12 tin nhắn lịch sử gần nhất** và **nội dung video/bài viết khách chia sẻ kèm** trong cuộc trò chuyện.
- **Điền và gửi chuẩn DOM Chrome:** Sử dụng sự kiện `paste` tương thích Draft.js/Lexical để cập nhật đúng trạng thái nhập liệu, tự bấm nút gửi máy bay giấy đỏ (`✈️`) và xác nhận ô nhập đã gửi thành công trước khi đánh dấu đã xử lý.

### 2. Tự động quét & trả lời Bình luận (`tiktok.com/business-suite/comments` & `tiktok.com`)
- **Tab Bình luận trong Business Suite:**
  - Tự chuyển sang tab `Bình luận`, mở lần lượt **5 video gần nhất** (tùy chỉnh được từ 1–15) trong danh sách `.infinite-scroll-component`.
  - Mở `iframe[src*="/video/"]`, tự cuộn từ từ xuống chạm đáy danh sách bình luận để tải đầy đủ các bình luận lazy-load, không bỏ sót bình luận phía dưới.
  - Định vị từng bình luận qua `[data-e2e="comment-reply-1"]`, tự động **bỏ qua** các bình luận đã có `Xem X câu trả lời`.
  - Đọc đầy đủ **tiêu đề + mô tả + hashtag video** kết hợp nội dung bình luận để trả lời đúng trọng tâm dịch vụ (hỏi giá/tư vấn thì giải đáp đúng dịch vụ và mời nhắn tin; bình luận khen/vui vẻ thì tương tác tự nhiên, không ép bán hàng).
  - Sau mỗi câu trả lời, tự quét lại DOM tươi, mở đúng **ô trả lời inline** ngay dưới bình luận đó và bấm nút gửi mũi tên hồng (`⬆️`), tránh bấm nhầm nút `X`.
- **Hỗ trợ trang chủ TikTok (`Hoạt động → Bình luận`):** Tự mở bảng `Thông báo`, chuyển tab `Bình luận`, mở video và trả lời các bình luận chưa có phản hồi.

### 3. Tài liệu nội bộ Spa (Gói dịch vụ & Bảng giá)
- Cung cấp ô nhập **Tài liệu nội bộ Spa** ngay trong tab **Gemini AI** của Popup.
- **Cơ chế ưu tiên:** Khi nhận tin nhắn hoặc bình luận, AI đối chiếu trực tiếp với tài liệu nội bộ trước. Nếu khớp dịch vụ có sẵn sẽ báo chính xác tên gói, giá tiền và liệu trình theo tài liệu (không tự bịa giá). Nếu khách hỏi nội dung ngoài tài liệu thì áp dụng lối văn CSKH mặc định.

### 4. Quy tắc ngôn ngữ thông minh (Việt / Anh)
- **Khách nhắn hoặc bình luận bằng tiếng Anh:** AI tự nhận diện và phản hồi **100% bằng tiếng Anh** lịch sự, tự nhiên (vẫn dịch chính xác gói dịch vụ và giá tiền từ tài liệu nội bộ nếu khớp).
- **Tất cả các trường hợp còn lại** (tiếng Việt có dấu, tiếng Việt viết tắt không dấu, emoji hoặc ngôn ngữ khác): Siết chặt 2 lớp bảo vệ (System Prompt + bộ lọc hậu kiểm) bắt buộc phản hồi **100% bằng tiếng Việt có dấu**.

### 5. Phân lịch độc lập, Đếm ngược trực tiếp & Bảo vệ chống spam
- **Phân tách thời gian quét riêng:** Tùy chỉnh độc lập chu kỳ **Quét Tin nhắn (giây)** và **Quét Bình luận (giây)**, kết hợp tùy chọn **Tự F5 làm mới trước mỗi vòng quét** để luôn bắt được tin nhắn và bình luận mới nhất.
- **Đồng hồ đếm ngược từng giây:** Hiển thị đếm ngược `MM:SS` cho cả phiên Tin nhắn và phiên Bình luận ngay trong Popup và trên thanh trạng thái nổi góc dưới phải màn hình TikTok (giữ đúng mốc thời gian kể cả sau khi F5).
- **An toàn vận hành:**
  - **Chế độ Nháp (Draft Mode):** Chỉ điền nội dung vào ô nhập mà không tự bấm gửi để kiểm tra trước khi chạy tự động.
  - **Chống gửi trùng (`dedupe`):** Chỉ lưu chống trùng sau khi tin nhắn/bình luận đã được gửi đi thật sự.
  - **Giới hạn tốc độ gửi/phút:** Cấu hình số lượng trả lời tối đa mỗi phút; khi chạm ngưỡng sẽ tự tạm nghỉ 15 giây rồi tiếp tục, không bỏ sót khách.
  - **Công cụ hỗ trợ:** Nút **Test kết nối Gemini**, **Quét ngay 1 vòng**, **Kiểm tra DOM trang đang mở**, **Nhật ký hoạt động** và **Reset chống trùng**.

### 6. Cơ chế tự thích ứng giao diện 4 tầng (Self-Healing Adaptive DOM)
- Khi TikTok cập nhật giao diện (đổi tên class CSS, bỏ thuộc tính `data-e2e`, đổi URL `iframe` hoặc gộp `iframe` ra trang chính), module `adaptive-dom.js` tự động chuyển tầng nhận diện theo thứ tự ưu tiên:
  1. **Tầng 1 (Semantic / `data-e2e` & URL iframe):** Bắt nhanh và chính xác nhất trên giao diện hiện hành.
  2. **Tầng 2 (Cấu trúc / `role="listitem"` & quét đa `iframe`):** Tự tìm đúng khung Tin nhắn / Bình luận kể cả khi đổi đường dẫn `iframe` hoặc bỏ `iframe`.
  3. **Tầng 3 (Neo nội dung & mốc thời gian Việt/Anh):** Nhận diện từng dòng hội thoại/video qua chuỗi thời gian (`11:43`, `19/11/2026`, `5 giờ`, `Không có bình luận mới nào`) và nhãn nút (`Trả lời`, `Reply`, `Đăng`, `Gửi`).
  4. **Tầng 4 (Hình học vị trí DOM — không phụ thuộc class/thuộc tính):** Tự xác định danh sách dọc lặp lại bên trái, khung chat chứa ô nhập liệu bên phải, cô lập từng khối bình luận theo đúng 1 nút `Trả lời`, và nhận diện nút gửi theo màu nhấn `#FE2C55` / phím `Enter`.
- Kết quả tầng đang kích hoạt (`adaptiveStrategies`) hiển thị trực tiếp khi bấm **Kiểm tra DOM trang đang mở**.

---

## Cấu trúc thư mục

```text
chrome-extension/
├── manifest.json              # Cấu hình Chrome Extension Manifest V3
├── background.js              # Service Worker: gọi Gemini API, tài liệu nội bộ, lọc ngôn ngữ, log & dedupe
├── content/
│   ├── dom-utils.js           # Tiện ích DOM cross-iframe, điền Draft.js/Lexical, tìm nút gửi & thanh trạng thái
│   ├── adaptive-dom.js        # Động cơ tự thích ứng giao diện 4 tầng (chống gãy khi TikTok đổi UI)
│   ├── business-suite.js      # Logic quét & trả lời Tin nhắn + Bình luận trên TikTok Business Suite
│   ├── tiktok-activity.js     # Logic quét & trả lời Bình luận qua Hoạt động trên tiktok.com
│   └── main.js                # Bộ điều phối phân lịch độc lập, tự F5 & đếm ngược từng giây
└── popup/
    ├── popup.html             # Giao diện điều khiển 3 tab (Điều khiển, Gemini AI, Nhật ký)
    ├── popup.css              # Giao diện dark-mode
    └── popup.js               # Xử lý lưu cấu hình, test API, đồng hồ đếm ngược & hiển thị nhật ký
```

---

## Hướng dẫn cài đặt & sử dụng

### Bước 1: Nạp Extension vào Google Chrome
1. Mở trình duyệt Chrome và truy cập `chrome://extensions/`.
2. Bật **Chế độ dành cho nhà phát triển (Developer mode)** ở góc trên bên phải.
3. Bấm **Tải tiện ích đã giải nén (Load unpacked)** và chọn thư mục `chrome-extension`.
4. Ghim icon chữ **T** lên thanh công cụ Chrome để tiện thao tác.

### Bước 2: Cấu hình Gemini AI & Tài liệu nội bộ
1. Bấm icon **T** $\rightarrow$ chọn tab **Gemini AI**.
2. Dán **Gemini API Key** (tạo tại Google AI Studio) và chọn model (khuyên dùng `gemini-3.8-flash`).
3. Bấm **Test kết nối Gemini** để kiểm tra kết nối thành công.
4. Dán bảng giá, các gói dịch vụ, liệu trình, địa chỉ spa vào ô **Tài liệu nội bộ Spa** và chỉnh sửa lối văn mặc định ở 2 ô kịch bản nếu cần $\rightarrow$ bấm **Lưu cấu hình AI**.

### Bước 3: Thiết lập lịch quét & chạy tự động
1. Mở trang `https://www.tiktok.com/business-suite/messages?lang=vi-VN&from=homepage` (đăng nhập sẵn tài khoản TikTok Business).
2. Mở Popup **T** $\rightarrow$ tab **Điều khiển**:
   - Bật các chế độ cần dùng (Tin nhắn, Tab Bình luận Business Suite, Tự F5 làm mới).
   - Cài đặt **Quét Tin nhắn (giây)**, **Quét Bình luận (giây)**, **Số hội thoại quét**, **Số video quét** và **Giới hạn gửi / phút**.
   - Nếu muốn kiểm tra thử trước, giữ tick **Chế độ Nháp (Không tự bấm Gửi)** và bấm **Quét ngay 1 vòng**.
   - Khi đã sẵn sàng chạy tự động hoàn toàn, bỏ tick **Chế độ Nháp**, bấm **Lưu cài đặt** và gạt công tắc góc trên phải sang **ON**.
