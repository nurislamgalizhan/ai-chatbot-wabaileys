import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorText } from "../api/client";
import { cancelWhatsApp, getWhatsApp, linkWhatsApp, logoutWhatsApp, type WhatsAppState } from "../api/endpoints";
import Icon from "../components/Icon";
import { toast } from "../components/ui";
import WaLinker from "../components/WaLinker";

const LINKING = new Set(["connecting", "qr", "pairing"]);

export default function WhatsAppPage() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["whatsapp"],
    queryFn: getWhatsApp,
    refetchInterval: (query) => (LINKING.has(query.state.data?.status ?? "") ? 2000 : 15000),
  });
  const onDone = (s: WhatsAppState) => {
    qc.setQueryData(["whatsapp"], s);
    void qc.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const onErr = (e: unknown) => toast(errorText(e) ?? "Ошибка", "error");
  const link = useMutation({ mutationFn: linkWhatsApp, onSuccess: onDone, onError: onErr });
  const cancel = useMutation({ mutationFn: cancelWhatsApp, onSuccess: onDone, onError: onErr });
  const off = useMutation({
    mutationFn: logoutWhatsApp,
    onSuccess: (s) => {
      onDone(s);
      toast("Номер отключён");
    },
    onError: onErr,
  });

  return (
    <div className="wa-page">
      <div className="wa-intro">
        <h2>Подключите свой номер WhatsApp</h2>
        <p className="muted">
          Alma AI работает как «связанное устройство» — так же, как WhatsApp Web. Телефон остаётся у вас: все
          сообщения по-прежнему видны в приложении, и вы можете отвечать сами в любой момент. После подключения в кабинет
          подтянется история переписок — столько, сколько отдаст телефон. Более старые сообщения можно догрузить в
          каждом чате кнопкой «Загрузить более раннюю историю».
        </p>
      </div>
      <WaLinker
        state={q.data}
        busy={link.isPending || cancel.isPending || off.isPending}
        onLink={(a) => link.mutate(a)}
        onCancel={() => cancel.mutate()}
        onLogout={() => off.mutate()}
        connectedNote="AI-агент отвечает клиентам, которые пишут на этот номер. Если вы ответите сами — с телефона или из раздела «Чаты» — бот замолчит в этом диалоге на время, указанное в настройках агента."
      />
      <div className="wa-tips">
        <div className="tip">
          <Icon name="shield" size={20} />
          <div>
            <b>Безопасно</b>
            <span>Ключи сессии хранятся в зашифрованном виде. Отключить доступ можно здесь или в самом WhatsApp.</span>
          </div>
        </div>
        <div className="tip">
          <Icon name="smartphone" size={20} />
          <div>
            <b>Телефон должен быть в сети</b>
            <span>Хотя бы раз в 14 дней, иначе WhatsApp сам отключит связанные устройства.</span>
          </div>
        </div>
        <div className="tip">
          <Icon name="users" size={20} />
          <div>
            <b>Группы не трогаем</b>
            <span>Бот отвечает только в личных чатах с клиентами. Группы и рассылки игнорируются.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
