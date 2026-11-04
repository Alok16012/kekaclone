/**
 * UI message catalogue: English and Hindi. Keys are stable identifiers; English is the fallback for any key a
 * language lacks. Pure data, shared by server and client. Coverage: the app shell, Home, Leave, Attendance, Inbox,
 * Profile and the sign-in flow (other modules stay English with the same hook available).
 */
export const LOCALES = ["en", "hi"] as const;
export type Locale = (typeof LOCALES)[number];
export const isLocale = (v: unknown): v is Locale => v === "en" || v === "hi";
export const LOCALE_LABELS: Record<Locale, string> = { en: "English", hi: "हिन्दी (Hindi)" };
export const DEFAULT_LOCALE: Locale = "en";
/** BCP 47 tags for Intl formatting. */
export const INTL_TAG: Record<Locale, string> = { en: "en-IN", hi: "hi-IN" };

const en = {
  // shell
  "nav.home": "Home", "nav.inbox": "Inbox", "nav.me": "Me", "nav.attendance": "Attendance", "nav.leave": "Leave", "nav.finances": "My finances", "nav.tax": "Income tax",
  "nav.loans": "Loans", "nav.expenses": "Expenses", "nav.performance": "Performance", "nav.helpdesk": "Helpdesk", "nav.assets": "My assets", "nav.tasks": "My tasks",
  "nav.surveys": "Surveys", "nav.jobs": "Jobs & referrals", "nav.timesheet": "Timesheet", "nav.learn": "Learning", "nav.organisation": "Organisation", "nav.dashboard": "Dashboard",
  "nav.team": "My team", "nav.people": "People", "nav.orgchart": "Org chart", "nav.documents": "Documents", "nav.onboarding": "Onboarding", "nav.exits": "Exits", "nav.analytics": "Analytics", "nav.payroll": "Payroll",
  "nav.expense_desk": "Expense desk", "nav.tax_desk": "Tax desk", "nav.loans_desk": "Loans desk", "nav.assets_admin": "Assets", "nav.helpdesk_queue": "Helpdesk queue",
  "nav.reviews": "Review cycles", "nav.compensation": "Compensation", "nav.projects": "Projects", "nav.learn_admin": "Learn admin", "nav.reports": "Reports", "nav.hiring": "Hiring",
  "nav.announcements": "Announcements", "nav.settings": "Settings",
  "shell.skip": "Skip to content", "shell.collapse": "Collapse", "shell.expand_sidebar": "Expand sidebar", "shell.collapse_sidebar": "Collapse sidebar", "shell.open_nav": "Open navigation",
  "shell.close_nav": "Close navigation", "shell.search": "Search people, pages, actions", "shell.notifications": "Notifications", "shell.account_menu": "Account menu for {name}",
  "shell.my_profile": "My profile", "shell.connections": "Calendar & devices", "shell.sign_out": "Sign out", "shell.pending": "pending",
  // home
  "home.morning": "Good morning", "home.afternoon": "Good afternoon", "home.evening": "Good evening",
  "home.approvals": "{count, plural, one {# request needs your approval} other {# requests need your approval}}", "home.open_inbox": "Open your Inbox",
  "home.leave_balance": "Leave balance", "home.this_leave_year": "This leave year", "home.apply": "Apply", "home.no_balances": "No leave balances yet.",
  "home.off_today": "Off today", "home.people_off": "{count, plural, one {# person} other {# people}}", "home.everyone_in": "Everyone's in today", "home.half_day": "half day",
  // clock
  "clock.shift": "{name} shift · {start} – {end}", "clock.holiday": "Holiday today", "clock.weekly_off": "Weekly off today", "clock.no_shift": "No shift today",
  "clock.since": "Clocked in since {time}", "clock.first_in": "First in at {time}", "clock.not_yet": "You haven't clocked in today", "clock.working": "Working", "clock.not_working": "Not working",
  "clock.in": "Clock in", "clock.out": "Clock out", "clock.locating": "Finding your location…", "clock.try_location": "Try location again", "clock.comment": "Comment",
  "clock.comment_required": "Add a short comment to clock in or out.", "clock.queued": "Saved on this phone. It will be sent when you're back online.",
  "clock.queued_count": "{count, plural, one {# punch waiting to send} other {# punches waiting to send}}", "clock.send_now": "Send now", "clock.synced": "Queued punches sent",
  "clock.sync_problem": "Some queued punches couldn't be recorded", "clock.offline": "You're offline",
  "clock.in_done": "Clocked in at {time}", "clock.out_done": "Clocked out at {time}", "clock.web_off": "Browser clock-in is off for you. Use your office's attendance device.",
  // leave
  "leave.title": "Leave", "leave.description": "Your balances, requests and the team's calendar.", "leave.apply": "Apply for leave", "leave.my_requests": "My requests",
  "leave.no_requests": "No leave requests yet", "leave.balance": "Balance", "leave.available": "available", "leave.cancel": "Cancel",
  "leave.status.pending": "Pending", "leave.status.approved": "Approved", "leave.status.rejected": "Declined", "leave.status.cancelled": "Cancelled",
  // attendance page
  "attendance.title": "Attendance", "attendance.description": "Clock in and out, see your days and raise requests.",
  // leave page (more)
  "leave.team_calendar": "Team calendar", "leave.policy": "Policy", "leave.no_plan_title": "You're not on a leave plan yet", "leave.no_plan": "Ask HR to add you to one. Until then there's nothing to apply for.",
  "leave.no_limit": "no limit", "leave.used_year": "{used} used this year", "leave.credited_line": "{credited} credited · {used} used", "leave.earned_line": "{credited} earned · {used} used", "leave.pending_part": " · {pending} pending",
  "leave.days": "{count, plural, one {# day} other {# days}}", "leave.first_half": "First half", "leave.second_half": "Second half", "leave.from_second": "from 2nd half", "leave.till_first": "till 1st half",
  "leave.your_requests": "Your requests", "leave.requests_hint": "Pending and upcoming first", "leave.no_requests_hint": "When you apply for leave, you can follow its approval here.", "leave.history": "History",
  "leave.cancel_title": "Cancel this leave?", "leave.cancel_back": "The days go back to your balance.", "leave.cancel_pending": "Your manager won't need to review it anymore.", "leave.cancel_confirm": "Cancel leave", "leave.cancelled": "Leave cancelled",
  // attendance page (more)
  "att.month": "Month", "att.prev": "Previous month", "att.next": "Next month", "att.avg": "Average worked per day", "att.days_logged": "{count, plural, one {# day with logs} other {# days with logs}}",
  "att.on_time": "On time", "att.on_time_hint": "arrived within the shift's grace", "att.late": "Late arrivals", "att.late_hint": "after shift start + grace", "att.penalties": "Penalties", "att.none": "None",
  "att.penalty_days": "{count, plural, one {# day} other {# days}}", "att.penalties_hint": "leave or loss of pay this month",
  "att.col.date": "Date", "att.col.status": "Status", "att.col.in": "First in", "att.col.out": "Last out", "att.col.worked": "Worked", "att.col.gross": "In office", "att.col.actions": "Actions",
  "att.late_m": "Late {m}m", "att.missing": "Missing swipe", "att.regularized": "Regularized", "att.ot": "OT {t}", "att.kind_pending": "{kind} pending", "att.requests_for": "Requests for {day}",
  "att.regularize": "Regularize", "att.regularize_day": "Regularize a day", "att.partial": "Partial day", "att.remote": "Work from home / on duty", "att.overtime": "Claim overtime", "att.shift": "Change shift", "att.swap": "Swap weekly off",
  "att.logs": "Logs", "att.requests": "Requests", "att.new_request": "New request", "att.log_caption": "Attendance log for {month}", "att.no_days": "No days to show yet", "att.no_days_hint": "Your attendance for this month appears here from your first working day.",
  "att.your_requests": "Your attendance requests", "att.your_requests_hint": "Regularizations, partial days, work from home, on duty, overtime and shift changes",
  "att.no_requests": "No requests yet", "att.no_requests_hint": "Forgot to clock out, working from home or stepping out early? Ask from a day's menu in your logs.",
  "att.withdraw_title": "Withdraw this request?", "att.withdraw_desc": "{title}, {detail}. Your manager won't need to review it anymore.", "att.withdraw": "Withdraw", "att.withdrawn": "Request withdrawn",
  "att.status.present": "Present", "att.status.absent": "Absent", "att.status.leave": "On leave", "att.status.half_leave": "Half-day leave", "att.status.half_day": "Half day", "att.status.wfh": "Work from home",
  "att.status.on_duty": "On duty", "att.status.weekly_off": "Weekly off", "att.status.half_weekly_off": "Half weekly off", "att.status.holiday": "Holiday", "att.status.today": "Today", "att.status.upcoming": "Upcoming", "att.status.not_joined": "Not with us yet",
  "att.kind.regularization": "Regularize", "att.kind.partial_day": "Partial day", "att.kind.wfh": "Work from home", "att.kind.on_duty": "On duty", "att.kind.overtime": "Overtime", "att.kind.shift_change": "Shift change", "att.kind.weekly_off_change": "Weekly off swap",
  // inbox
  "inbox.title": "Inbox", "inbox.waiting": "{count, plural, one {# request is waiting for your decision.} other {# requests are waiting for your decision.}}",
  "inbox.empty_title": "Nothing waiting for you", "inbox.empty": "Requests that need your decision.", "inbox.handover": "Going away? Hand over",
  "inbox.approve": "Approve", "inbox.decline": "Decline", "inbox.comment": "Comment (optional)",
  // profile
  "profile.title": "Profile", "profile.about": "About", "profile.job": "Job", "profile.contact": "Contact details", "profile.personal": "Personal details", "profile.addresses": "Addresses", "profile.team": "Team",
  // login
  "login.title": "Sign in to {company}", "login.email_hint": "Use your work email.", "login.email": "Work email", "login.password": "Password", "login.submit": "Sign in",
  "login.forgot": "Forgot password?", "login.captcha_help": "A quick check after a few failed attempts. Answer in digits or words.", "login.or": "or", "login.mobile": "Sign in with mobile OTP", "login.language": "Language",
  // generic
  "common.save": "Save", "common.cancel": "Cancel", "common.close": "Close", "common.loading": "Loading…", "common.error": "Something went wrong. Please try again.",
  "lang.label": "Language", "lang.help": "Dates and numbers follow the language too.", "lang.saved": "Language saved",
} as const;

export type MessageKey = keyof typeof en;

const hi: Partial<Record<MessageKey, string>> = {
  "nav.home": "होम", "nav.inbox": "इनबॉक्स", "nav.me": "मैं", "nav.attendance": "उपस्थिति", "nav.leave": "छुट्टी", "nav.finances": "मेरी कमाई", "nav.tax": "आयकर",
  "nav.loans": "ऋण", "nav.expenses": "खर्च", "nav.performance": "प्रदर्शन", "nav.helpdesk": "हेल्पडेस्क", "nav.assets": "मेरी संपत्तियाँ", "nav.tasks": "मेरे काम",
  "nav.surveys": "सर्वेक्षण", "nav.jobs": "नौकरियाँ और रेफ़रल", "nav.timesheet": "टाइमशीट", "nav.learn": "सीखना", "nav.organisation": "संगठन", "nav.dashboard": "डैशबोर्ड",
  "nav.team": "मेरी टीम", "nav.people": "लोग", "nav.orgchart": "संगठन चार्ट", "nav.documents": "दस्तावेज़", "nav.onboarding": "ऑनबोर्डिंग", "nav.exits": "निकासी", "nav.analytics": "विश्लेषण", "nav.payroll": "पेरोल",
  "nav.expense_desk": "खर्च डेस्क", "nav.tax_desk": "कर डेस्क", "nav.loans_desk": "ऋण डेस्क", "nav.assets_admin": "संपत्तियाँ", "nav.helpdesk_queue": "हेल्पडेस्क कतार",
  "nav.reviews": "समीक्षा चक्र", "nav.compensation": "वेतन संशोधन", "nav.projects": "प्रोजेक्ट", "nav.learn_admin": "लर्न एडमिन", "nav.reports": "रिपोर्ट", "nav.hiring": "भर्ती",
  "nav.announcements": "घोषणाएँ", "nav.settings": "सेटिंग्स",
  "shell.skip": "सीधे सामग्री पर जाएँ", "shell.collapse": "समेटें", "shell.expand_sidebar": "साइडबार खोलें", "shell.collapse_sidebar": "साइडबार समेटें", "shell.open_nav": "मेनू खोलें",
  "shell.close_nav": "मेनू बंद करें", "shell.search": "लोग, पेज, काम खोजें", "shell.notifications": "सूचनाएँ", "shell.account_menu": "{name} का खाता मेनू",
  "shell.my_profile": "मेरी प्रोफ़ाइल", "shell.connections": "कैलेंडर और डिवाइस", "shell.sign_out": "साइन आउट", "shell.pending": "लंबित",
  "home.morning": "सुप्रभात", "home.afternoon": "नमस्ते", "home.evening": "शुभ संध्या",
  "home.approvals": "{count, plural, one {# अनुरोध आपकी मंज़ूरी का इंतज़ार कर रहा है} other {# अनुरोध आपकी मंज़ूरी का इंतज़ार कर रहे हैं}}", "home.open_inbox": "अपना इनबॉक्स खोलें",
  "home.leave_balance": "छुट्टी का बैलेंस", "home.this_leave_year": "इस छुट्टी वर्ष में", "home.apply": "आवेदन करें", "home.no_balances": "अभी कोई छुट्टी बैलेंस नहीं है।",
  "home.off_today": "आज अवकाश पर", "home.people_off": "{count, plural, one {# व्यक्ति} other {# लोग}}", "home.everyone_in": "आज सब मौजूद हैं", "home.half_day": "आधा दिन",
  "clock.shift": "{name} शिफ़्ट · {start} – {end}", "clock.holiday": "आज छुट्टी है", "clock.weekly_off": "आज साप्ताहिक अवकाश है", "clock.no_shift": "आज कोई शिफ़्ट नहीं",
  "clock.since": "{time} से क्लॉक-इन", "clock.first_in": "पहली बार {time} पर आए", "clock.not_yet": "आपने आज क्लॉक-इन नहीं किया है", "clock.working": "काम पर", "clock.not_working": "काम पर नहीं",
  "clock.in": "क्लॉक इन", "clock.out": "क्लॉक आउट", "clock.locating": "आपका स्थान खोजा जा रहा है…", "clock.try_location": "स्थान फिर से आज़माएँ", "clock.comment": "टिप्पणी",
  "clock.comment_required": "क्लॉक इन/आउट के लिए छोटी टिप्पणी जोड़ें।", "clock.queued": "इस फ़ोन पर सहेजा गया। ऑनलाइन होते ही भेज दिया जाएगा।",
  "clock.queued_count": "{count, plural, one {# पंच भेजा जाना बाकी} other {# पंच भेजे जाने बाकी}}", "clock.send_now": "अभी भेजें", "clock.synced": "कतार के पंच भेज दिए गए",
  "clock.sync_problem": "कुछ पंच दर्ज नहीं हो सके", "clock.offline": "आप ऑफ़लाइन हैं",
  "clock.in_done": "{time} पर क्लॉक-इन हुआ", "clock.out_done": "{time} पर क्लॉक-आउट हुआ", "clock.web_off": "आपके लिए ब्राउज़र से क्लॉक-इन बंद है। दफ़्तर की उपस्थिति मशीन इस्तेमाल करें।",
  "leave.title": "छुट्टी", "leave.description": "आपके बैलेंस, अनुरोध और टीम का कैलेंडर।", "leave.apply": "छुट्टी के लिए आवेदन", "leave.my_requests": "मेरे अनुरोध",
  "leave.no_requests": "अभी कोई छुट्टी अनुरोध नहीं", "leave.balance": "बैलेंस", "leave.available": "उपलब्ध", "leave.cancel": "रद्द करें",
  "leave.status.pending": "लंबित", "leave.status.approved": "स्वीकृत", "leave.status.rejected": "अस्वीकृत", "leave.status.cancelled": "रद्द",
  "attendance.title": "उपस्थिति", "attendance.description": "क्लॉक इन/आउट करें, अपने दिन देखें और अनुरोध करें।",
  "leave.team_calendar": "टीम कैलेंडर", "leave.policy": "नीति", "leave.no_plan_title": "आप अभी किसी छुट्टी योजना में नहीं हैं", "leave.no_plan": "HR से आपको किसी योजना में जोड़ने को कहें। तब तक आवेदन के लिए कुछ नहीं है।",
  "leave.no_limit": "कोई सीमा नहीं", "leave.used_year": "इस साल {used} इस्तेमाल", "leave.credited_line": "{credited} जमा · {used} इस्तेमाल", "leave.earned_line": "{credited} अर्जित · {used} इस्तेमाल", "leave.pending_part": " · {pending} लंबित",
  "leave.days": "{count, plural, one {# दिन} other {# दिन}}", "leave.first_half": "पहला आधा दिन", "leave.second_half": "दूसरा आधा दिन", "leave.from_second": "दूसरे आधे दिन से", "leave.till_first": "पहले आधे दिन तक",
  "leave.your_requests": "आपके अनुरोध", "leave.requests_hint": "लंबित और आने वाले पहले", "leave.no_requests_hint": "छुट्टी के लिए आवेदन करने पर उसकी मंज़ूरी यहाँ देख सकते हैं।", "leave.history": "पुराने अनुरोध",
  "leave.cancel_title": "यह छुट्टी रद्द करें?", "leave.cancel_back": "ये दिन आपके बैलेंस में वापस जुड़ जाएँगे।", "leave.cancel_pending": "आपके मैनेजर को अब इसकी समीक्षा नहीं करनी होगी।", "leave.cancel_confirm": "छुट्टी रद्द करें", "leave.cancelled": "छुट्टी रद्द हो गई",
  "att.month": "महीना", "att.prev": "पिछला महीना", "att.next": "अगला महीना", "att.avg": "रोज़ का औसत काम", "att.days_logged": "{count, plural, one {# दिन का रिकॉर्ड} other {# दिनों का रिकॉर्ड}}",
  "att.on_time": "समय पर", "att.on_time_hint": "शिफ़्ट की छूट के भीतर पहुँचे", "att.late": "देर से आए", "att.late_hint": "शिफ़्ट शुरू होने + छूट के बाद", "att.penalties": "जुर्माने", "att.none": "कोई नहीं",
  "att.penalty_days": "{count, plural, one {# दिन} other {# दिन}}", "att.penalties_hint": "इस महीने छुट्टी या वेतन कटौती",
  "att.col.date": "तारीख़", "att.col.status": "स्थिति", "att.col.in": "पहली एंट्री", "att.col.out": "आख़िरी निकास", "att.col.worked": "काम किया", "att.col.gross": "दफ़्तर में", "att.col.actions": "कार्रवाई",
  "att.late_m": "{m} मिनट देर", "att.missing": "स्वाइप छूटा", "att.regularized": "नियमित किया गया", "att.ot": "ओवरटाइम {t}", "att.kind_pending": "{kind} लंबित", "att.requests_for": "{day} के अनुरोध",
  "att.regularize": "नियमित करें", "att.regularize_day": "किसी दिन को नियमित करें", "att.partial": "आंशिक दिन", "att.remote": "घर से काम / ऑन ड्यूटी", "att.overtime": "ओवरटाइम का दावा", "att.shift": "शिफ़्ट बदलें", "att.swap": "साप्ताहिक अवकाश बदलें",
  "att.logs": "रिकॉर्ड", "att.requests": "अनुरोध", "att.new_request": "नया अनुरोध", "att.log_caption": "{month} का उपस्थिति रिकॉर्ड", "att.no_days": "अभी दिखाने को कोई दिन नहीं", "att.no_days_hint": "इस महीने की आपकी उपस्थिति पहले कार्यदिवस से यहाँ दिखेगी।",
  "att.your_requests": "आपके उपस्थिति अनुरोध", "att.your_requests_hint": "नियमितीकरण, आंशिक दिन, घर से काम, ऑन ड्यूटी, ओवरटाइम और शिफ़्ट बदलाव",
  "att.no_requests": "अभी कोई अनुरोध नहीं", "att.no_requests_hint": "क्लॉक आउट करना भूल गए, घर से काम कर रहे हैं या जल्दी निकल रहे हैं? रिकॉर्ड में उस दिन के मेनू से अनुरोध करें।",
  "att.withdraw_title": "यह अनुरोध वापस लें?", "att.withdraw_desc": "{title}, {detail}। आपके मैनेजर को अब इसकी समीक्षा नहीं करनी होगी।", "att.withdraw": "वापस लें", "att.withdrawn": "अनुरोध वापस लिया गया",
  "att.status.present": "उपस्थित", "att.status.absent": "अनुपस्थित", "att.status.leave": "छुट्टी पर", "att.status.half_leave": "आधे दिन की छुट्टी", "att.status.half_day": "आधा दिन", "att.status.wfh": "घर से काम",
  "att.status.on_duty": "ऑन ड्यूटी", "att.status.weekly_off": "साप्ताहिक अवकाश", "att.status.half_weekly_off": "आधा साप्ताहिक अवकाश", "att.status.holiday": "छुट्टी का दिन", "att.status.today": "आज", "att.status.upcoming": "आने वाला", "att.status.not_joined": "अभी जुड़े नहीं",
  "att.kind.regularization": "नियमितीकरण", "att.kind.partial_day": "आंशिक दिन", "att.kind.wfh": "घर से काम", "att.kind.on_duty": "ऑन ड्यूटी", "att.kind.overtime": "ओवरटाइम", "att.kind.shift_change": "शिफ़्ट बदलाव", "att.kind.weekly_off_change": "साप्ताहिक अवकाश बदलाव",
  "inbox.title": "इनबॉक्स", "inbox.waiting": "{count, plural, one {# अनुरोध आपके निर्णय का इंतज़ार कर रहा है।} other {# अनुरोध आपके निर्णय का इंतज़ार कर रहे हैं।}}",
  "inbox.empty_title": "आपके लिए कुछ लंबित नहीं", "inbox.empty": "ऐसे अनुरोध जिन पर आपका निर्णय चाहिए।", "inbox.handover": "बाहर जा रहे हैं? ज़िम्मेदारी सौंपें",
  "inbox.approve": "मंज़ूर करें", "inbox.decline": "अस्वीकार करें", "inbox.comment": "टिप्पणी (वैकल्पिक)",
  "profile.title": "प्रोफ़ाइल", "profile.about": "परिचय", "profile.job": "नौकरी", "profile.contact": "संपर्क विवरण", "profile.personal": "व्यक्तिगत विवरण", "profile.addresses": "पते", "profile.team": "टीम",
  "login.title": "{company} में साइन इन करें", "login.email_hint": "अपना कार्य ईमेल इस्तेमाल करें।", "login.email": "कार्य ईमेल", "login.password": "पासवर्ड", "login.submit": "साइन इन",
  "login.forgot": "पासवर्ड भूल गए?", "login.captcha_help": "कुछ असफल प्रयासों के बाद एक छोटी जाँच। अंकों या शब्दों में उत्तर दें।", "login.or": "या", "login.mobile": "मोबाइल OTP से साइन इन", "login.language": "भाषा",
  "common.save": "सहेजें", "common.cancel": "रद्द करें", "common.close": "बंद करें", "common.loading": "लोड हो रहा है…", "common.error": "कुछ गड़बड़ हो गई। कृपया फिर कोशिश करें।",
  "lang.label": "भाषा", "lang.help": "तारीख़ें और संख्याएँ भी इसी भाषा में दिखेंगी।", "lang.saved": "भाषा सहेजी गई",
};

export const MESSAGES: Record<Locale, Partial<Record<MessageKey, string>>> = { en, hi };

/** How much of the catalogue each language covers (shown honestly in Settings). */
export function coverage(locale: Locale) {
  const total = Object.keys(en).length, done = Object.keys(MESSAGES[locale]).length;
  return { total, done, percent: Math.round((done / total) * 100) };
}
